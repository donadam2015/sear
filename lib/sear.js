var events = require('events');
var util = require('util');
var path = require('path');
var normalize = path.normalize;
var exec = require('child_process').exec;
var extname = path.extname;
var _ = require('lodash');
var fs = require('fs');
var UglifyJS = require('uglify-js');
var express = require('express');
var http = require('http');
var CombinedStream = require('combined-stream');
var send = require('send');
var url = require('url');
var es = require('event-stream');
var resolve = require('resolve');
var commands = require('./utils/commands');
var UpdateServer = require('./updateserver');
var FileWatcher = require('./filewatcher');
var debug = require('debug')('sear');

var SearFile = require('./file');
var SearModule = require('./module');
var SearBundle = require('./bundle');

var Sear = function (options) {
  var self = this;

  options = options || {};

  events.EventEmitter.call(this);
  this.options = options || {};

  this.options.input = path.resolve(this.options.input || '.');
  this.options.bower_components = options.bower_components || 'bower_components';
  this.options.node_modules = options.node_modules || 'node_modules';

  this.extensions = {};
  this.walkers = {};
  this.updaters = {};
  this.filePaths = {};
  this.commands = {};

  _.map(commands, function (fn, name) {
    self.commands[name] = _.bind(fn, self);
  });

  this.registerExtension(require('./extensions/javascript'));
  this.registerExtension(require('./extensions/jsx'));
  this.registerExtension(require('./extensions/coffee'));
  this.registerExtension(require('./extensions/css'));
  this.registerExtension(require('./extensions/less'));
  this.registerExtension(require('./extensions/stylus'));
  this.registerExtension(require('./extensions/markdown'));
  this.registerExtension(require('./extensions/haml'));
  this.registerExtension(require('./extensions/html'));
  this.registerExtension(require('./extensions/json'));
  this.registerExtension(require('./extensions/sass'));
  this.registerExtension(require('./extensions/macro'));
};

util.inherits(Sear, events.EventEmitter);

Sear.prototype.registerExtension = function (extension) {
  for (var fileExtension in extension) {
    this.extensions[fileExtension] = extension[fileExtension].bind(this);
    if (extension[fileExtension].createWalker) {
      this.walkers[fileExtension] = extension[fileExtension].createWalker.bind(this);
    }
    if (extension[fileExtension].updater) {
      this.updaters[fileExtension] = extension[fileExtension].updater.bind(this);
    }
  }
};

Sear.prototype.build = function (module, callback) {
  var self = this;
  var files = {};

  if (arguments.length === 1) {
    callback = module;
    module = this.options.name;
  }

  debug("Building %s", module);

  if (!module) {
    return callback(new Error("Module name not specified"));
  }

  (function loadFile(base, filename, loader, callback) {
    filename = filename.replace(/\.js$/, '');

    self._resolve(base, filename, function (err, filePath) {
      if (err) {
        return callback(err);
      }

      if (filePath) {
        filePath = path.relative(self.options.input, filePath).replace(/\.js$/, '');
      }

      if (files[filePath]) {
        if (loader) {
          files[filePath].loaded_by.push(loader);
        }
        return callback();
      }

      self.loadFile(base, filename, function (err, details) {
        if (err) {
          err.file = path.join(base, filename);
          return callback(err);
        }

        files[filePath] = details;
        details.loaded_by = loader ? [loader] : [];

        debug("Going trough file dependencies %s %s", base, filename);

        (function nextDep(i) {
          var dep = details.dependencies[i];

          if (!dep) {
            return callback();
          }

          var depBase = path.relative(self.options.input, details.path).split('/');
          depBase.pop();
          depBase = depBase.join('/');
          var depFilename = dep.path;

          debug("Dependency %s %s", depBase, depFilename);

          self._resolve(depBase, depFilename, function (err, depPath) {
            dep.key = depPath;
            loadFile(depBase, depFilename, {type: dep.type, path: filePath, item: dep.item}, function (err) {
              if (err) {
                return callback(err);
              }

              nextDep(++i);
            });
          });
        })(0);
      });
    });
  })('', './' + module, null, function (err) {
    if (err) {
      return callback(err);
    }

    self._includesToAST(function (err, includes) {
      if (err) {
        return callback(err);
      }
      var bundle = new SearBundle(module, self, files, includes);
      callback(err, bundle);
    });
  });
};

Sear.prototype._includesToAST = function (callback) {
  var self = this;
  this._getIncludes(function (err, includes) {
    if (err) {
      return callback(err);
    }

    var nodes = [];

    (function nextInclude(i) {
      var include = includes[i];
      if (!include) {
        return callback(null, nodes);
      }

      self._toAST(include.data.toString(), include.name, function (err, ast) {
        if (err) {
          return callback(err);
        }

        nodes.push(ast);
        nextInclude(++i);
      });
    })(0);
  }, true);
};

Sear.prototype._getIncludes = function (callback, asObjects) {
  var includes = _.without(this.options.includes || [], 'sear-require', 'requirejs');
  var contents = [];

  var self = this;

  (function nextInclude(i) {
    var include = includes[i];
    if (!include) {
      return self._getSearIncludes(function (err, includes) {
        if (err) {
          return callback(err);
        }
        contents = contents.concat(asObjects ? includes : _.map(includes, function (include) {
          return include.data.toString();
        }));
        return callback(null, asObjects ? contents : contents.join('\n'));
      });
    }

    self._getFileContent('', include, function (err, data, filename) {
      if (err) {
        return callback(err);
      }
      contents.push(asObjects ? {data: data, name: filename} : data.toString());
      nextInclude(++i);
    });
  })(0);
};

Sear.prototype._getSearIncludes = function (callback) {
  var searIncludes = [];
  var srFilename = require.resolve('sear-require');
  fs.readFile(srFilename, _.bind(function (err, data) {
    if (err) {
      return callback(err);
    }
    searIncludes.push({data: data, name: 'sear-require'});
    if (this.updateServer) {
      this.updateServer.getClient(function (err, data) {
        if (err) {
          return callback(err);
        }

        searIncludes.push({data: data, name: 'sear-updater'});
        callback(null, searIncludes);
      });
    } else {
      callback(null, searIncludes);
    }
  }, this));
};

Sear.prototype._cleanPath = function (p) {
  if (p.indexOf('node_modules')  > -1) {
    p = p.split('node_modules').pop();
  }

  if (p.indexOf('bower_components')  > -1) {
    p = p.split('bower_components').pop();
  }

  if (p.indexOf(this.options.node_modules) === 0) {
    p = p.substr(this.options.node_modules.length);
  } else if (p.indexOf(this.options.bower_components) === 0) {
    p = p.substr(this.options.bower_components.length);
  } else if (p.indexOf(path.join(this.options.input, this.options.node_modules)) === 0) {
    p = p.substr(path.join(this.options.input, this.options.node_modules).length);
  } else if (p.indexOf(path.join(this.options.input, this.options.bower_components)) === 0) {
    p = p.substr(path.join(this.options.input, this.options.bower_components).length);
  } else if (p.indexOf(this.options.input) === 0) {
    p = p.substr(this.options.input.length);
  }

  return p;
};

Sear.prototype._resolve = function (base, filepath, callback) {
  filepath = this._cleanPath(filepath);

  if (base && base.indexOf('node_modules') > -1) {
    base = 'node_modules' + this._cleanPath(base);
  }

  debug("Resolving %s %s", base, filepath);

  var fullPath = path.join(base, filepath);

  if (this.filePaths[fullPath]) {
    debug("Resolved from cache %s = %s", fullPath, this.filePaths[fullPath]);
    return callback(null, this.filePaths[fullPath]);
  }

  var resolveFile = function (base, filepath) {
    filepath = this._cleanPath(filepath);

    if (filepath.indexOf('/') === 0) {
      filepath = filepath.substr(1);
    }

    var opts = {
      moduleDirectory: this.options.resolve_module_directories ||
                       [this.options.bower_components, this.options.node_modules],
      basedir: base,
      extensions: _.keys(this.extensions).map(function (ext) {
        return '.' + ext;
      })
    };


    resolve(filepath, opts, function (err, res) {
      if (err) {
        debug("Unable to resolve %s", fullPath);
        err.path = filepath;
        err.base = path.relative(this.options.input, base);
        return callback(err);
      }

      if (res.indexOf('node_modules/') > -1) {
        res = path.join(this.options.input, 'node_modules', this._cleanPath(res));
      }

      this.filePaths[fullPath] = res;
      debug("Resolved %s = %s", fullPath, this.filePaths[fullPath]);
      callback(err, res);
    }.bind(this));
  }.bind(this);

  if (filepath.indexOf('/') === -1) {
    resolveFile(this.options.input, filepath);
  } else if (base) {
    if (base.indexOf('.') === 0) {
      base = base.substr(1);
    }

    if (base.indexOf('/') === 0) {
      base = base.substr(1);
    }

    this._resolve('', base, function (err, baseFullPath) {
      if (baseFullPath) {
        var parts = baseFullPath.split('/');
        parts.pop();
        base = parts.join('/');
      } else {
        base = path.join(this.options.input, base);
      }

      resolveFile(base, filepath);
    }.bind(this));
  } else {
    resolveFile(this.options.input, filepath);
  }
};

Sear.prototype._getExtension = function (file) {
  var ext = extname(file) || '.js';
  ext = ext.substr(1);
  return this.extensions[ext] || function (base, filepath, data, callback) {
    callback(new Error('No extension for ' + ext + '-files'), data);
  };
};

Sear.prototype._getWalker = function (file) {
  var ext = extname(file) || '.js';
  ext = ext.substr(1);
  return this.walkers[ext] || function (base, filepath, node) {
    return function () {};
  };
};

Sear.prototype._transform = function (filepath, data, callback) {
  debug('Transforming %s', filepath);
  this._getExtension(filepath)(filepath, data, callback);
};

Sear.prototype._wrap = function (details, callback) {
  debug('Wrapping %s %s', details.base, details.relative_path);

  var self = this;
  var name;

  function wrap() {
    name = self._cleanPath(name);

    if (name.indexOf('/') !== 0) {
      name = '/' + name;
    }

    var requires = ['require', 'exports', 'module'];
    _.each(details.dependencies, function (dep) {
      var value = dep.item.value;
      if (value.indexOf('/') !== 0) {
        value = '/' + value;
      }
      dep.item.value = value;
      if (dep.type === 'require') {
        requires.push(value);
      }
    });

    requires = _.uniq(requires);

    if (details.ast.defineNode && details.ast.defineNode.args[0] && details.ast.defineNode.args[0].elements) {
      details.ast.defineNode.args.unshift(new UglifyJS.AST_String({value: name}));
    }

    var defineDeps = _.where(details.dependencies, {type: 'define'});
    if (defineDeps.length > 0) {
      return callback(null, details);
    }

    var argnames = ['require', 'exports', 'module'].map(function (item) {
      return new UglifyJS.AST_SymbolFunarg({name: item});
    });

    var requireAst = new UglifyJS.AST_Array({elements: requires.map(function (item) {
      return new UglifyJS.AST_String({value: item});
    })});

    var nameAst = new UglifyJS.AST_String({value: name});

    if (details.ast.defineNode) {
      var amdcallback = details.ast.defineNode.args.pop();
      details.ast.defineNode.args = [
        nameAst,
        requireAst,
        amdcallback
      ];
    } else {
      var anonymousFunction = new UglifyJS.AST_Function({
        argnames: argnames,
        body: details.ast.body
      });

      details.ast.body = [
        new UglifyJS.AST_Call({
          expression: new UglifyJS.AST_SymbolRef({ name: 'define' }), args: [
          nameAst,
          requireAst,
          anonymousFunction
        ]
        })
      ];
    }

    callback (null, details);
  }

  name = self._cleanPath(details.path).replace(/\.js$/, '');
  wrap();
};

Sear.prototype._getDependencyName = function (dep, base, filepath) {
  if (this.options.dependency_overrides && typeof this.options.dependency_overrides[dep] !== 'undefined') {
    return this.options.dependency_overrides[dep];
  }

  return dep;
};

/*
 Borrowed from https://github.com/fishbar/jscoverage/blob/master/lib/instrument.js
*/

Sear.prototype._covInstrumentationWalk = function (filename, lines, conds) {
  filename = path.relative(this.options.input, filename);
  if (this.options.cov_exclude && _.filter(this.options.cov_exclude, function (file) {
    if (file[file.length - 1] === '*') {
      return filename.indexOf(file.substr(0, file.length - 1)) === 0;
    } else {
      return filename === file;
    }
  }).length > 0) {
    return;
  }

  debug('Creating code coverage instrumentation walker for ' + filename);

  return function (node, walker) {
    if (this._covCheckIfIgnore(node, walker.stack)) {
        return;
    }

    if (node instanceof UglifyJS.AST_Conditional) { // 三元判断
      node.consequent = this._covInject('cond', node.consequent.start.line, node.consequent, filename, lines, conds);
      node.alternative = this._covInject('cond', node.alternative.start.line, node.alternative, filename, lines, conds);
    } else if (node.TYPE === 'Binary') {
      if (!(node.left instanceof UglifyJS.AST_Constant)) {
        node.left = this._covInject('cond', node.left.start.line, node.left, filename, lines, conds);
      }
      if (!(node.right instanceof UglifyJS.AST_Constant)) {
        node.right = this._covInject('cond', node.right.start.line, node.right, filename, lines, conds);
      }
    }
    var len = node.body ? node.body.length : 0;
    if (len) {
      var res = [];
      var subNode;
      for (var i = 0; i < len; i++) {
        subNode = node.body[i];
        if (this._covCheckIfIgnore(subNode, walker.stack)) {
          res.push(subNode);
          continue;
        }
        if (subNode instanceof UglifyJS.AST_Statement) {
          if (this._covIfExclude(subNode)) {
            res.push(subNode);
            continue;
          }
          res.push(this._covInject('line', subNode.start.line, null, filename, lines, conds));
        } else if (subNode instanceof UglifyJS.AST_Var) {
          res.push(this._covInject('line', subNode.start.line, null, filename, lines, conds));
        }
        res.push(subNode);
      }
      node.body = res;
    }
  }.bind(this);
};

/**
 * @private
 * @param  {String} type  inject type, line | conds
 * @param  {Number} line  line number
 * @param  {Object} expr  any expression, or node, or statement
 * @return {AST_Func} Object
 */
Sear.prototype._covInject = function (type, line, expr, filename, lines, conds) {
  var args = [];
  if (type === 'line') {
    lines.push(line);
    args = [
      new UglifyJS.AST_String({value: filename}),
      new UglifyJS.AST_String({value: type}),
      new UglifyJS.AST_Number({value: line})
    ];
  } else if (type === 'cond') {
    var start = expr.start.col;
    var offset = expr.end.endpos - expr.start.pos;
    var key = line + '_' + start + '_' + offset;  // 编码
    conds[key] = 0;
    args = [
      new UglifyJS.AST_String({value: filename}),
      new UglifyJS.AST_String({value: type}),
      new UglifyJS.AST_String({value: key}),
      expr
    ];
  }

  var call = new UglifyJS.AST_Call({
    expression: new UglifyJS.AST_SymbolRef({name: '_$jscmd'}),
    //end: new UglifyJS.AST_
    args: args
  });

  if (type === this.T_LINE) {
    return new UglifyJS.AST_SimpleStatement({
      body: call,
      end: new UglifyJS.AST_Token({value: ';'})
    });
  } else {
    return call;
  }
};

/**
 * check if need inject
 * @param  {AST_Node} node
 * @return {Boolean}
 */
Sear.prototype._covIfExclude = function (node) {
  if (node instanceof UglifyJS.AST_LoopControl) {
    return false;
  }
  if (
    node instanceof UglifyJS.AST_IterationStatement ||
    node instanceof UglifyJS.AST_StatementWithBody ||
    node instanceof UglifyJS.AST_Block
  ) {
    return true;
  }
};

Sear.prototype._covCheckIfIgnore = function (node, stack) {
  var cmt;
  if (node.start && node.start.comments_before.length) {
    cmt = node.start.comments_before[node.start.comments_before.length - 1];
    if (/@covignore/.test(cmt.value) && !(node instanceof UglifyJS.AST_Toplevel)) {
      node.__covignore = true;
    }
  }
  if (node.__covignore) {
    return true;
  }
  if (stack) {
    for (var i = stack.length - 1; i > 0; i--) {
      if (stack[i].__covignore) {
        return true;
      }
    }
  }
  return false;
};


function jscFunctionBody() {
  /* jshint ignore:start */
  // instrument by jscoverage, do not modifly this file
  (function (file, lines, conds, source) {
    var BASE;
    if (typeof global === 'object') {
      BASE = global;
    } else if (typeof window === 'object') {
      BASE = window;
    } else {
      throw new Error('[jscoverage] unknow ENV!');
    }
    if (BASE._$jscoverage) {
      BASE._$jscmd(file, 'init', lines, conds, source);
      return;
    }
    var cov = {};
    /**
     * jsc(file, 'init', lines, condtions)
     * jsc(file, 'line', lineNum)
     * jsc(file, 'cond', lineNum, expr, start, offset)
     */
    function jscmd(file, type, line, express, start, offset) {
      var storage;
      switch (type) {
        case 'init':
          storage = [];
          for (var i = 0; i < line.length; i ++) {
            storage[line[i]] = 0;
          }
          var condition = express;
          var source = start;
          storage.condition = condition;
          storage.source = source;
          cov[file] = storage;
          break;
        case 'line':
          storage = cov[file];
          storage[line] ++;
          break;
        case 'cond':
          storage = cov[file];
          storage.condition[line] ++;
          return express;
      }
    }

    BASE._$jscoverage = cov;
    BASE._$jscmd = jscmd;
    jscmd(file, 'init', lines, conds, source);
  })('$file$', $lines$, $conds$, $source$);
  /* jshint ignore:end */
}


Sear.prototype._walk = function (base, filepath, basenode, filename, data, callback) {
  var dependencies = [];
  var self = this;

  debug('Resolving dependencies %s %s', base, filepath);

  var extWalker = this._getWalker(filepath)(filename, basenode);
  var covWalker, lines, conds;
  if (this.options.cov_instrumentation) {
    lines = [];
    conds = {};
    covWalker = this._covInstrumentationWalk(filename, lines, conds);
  }

  var walker = new UglifyJS.TreeWalker(function(node){
    if (node instanceof UglifyJS.AST_Call && node.expression.name === 'define') {
      basenode.defineNode = node;
      var elements = (node.args[0] && node.args[0].elements) ?
        node.args[0].elements : ((node.args[1] && node.args[1].elements) ? node.args[1].elements : null);

      if (elements) {
        _.each(elements, function (item) {
          var value = item.value = self._getDependencyName(item.value, base, filepath);
          // TODO add support of totally removing the dependency
          if (['module', 'exports', 'require'].indexOf(value) === -1) {
            dependencies.push({path: value, type: node.expression.name, item: item});
          }
        });
      }
    } else if (node instanceof UglifyJS.AST_Call &&
      (node.expression.name === 'require' ||  node.expression.name === 'lazyload')) {
      var item = node.args[0];
      // TODO add support of totally removing the dependency
      var value = item.value = self._getDependencyName(item.value, base, filepath);
      dependencies.push({path: value, type: node.expression.name, item: item});
    }

    extWalker(node, walker);
    if (covWalker) {
      covWalker(node, walker);
    }
  });

  basenode.walk(walker);

  if (covWalker) {
    var jscfArray = jscFunctionBody.toString().split('\n');
    jscfArray = jscfArray.slice(1, jscfArray.length - 1);
    var ff = jscfArray.join('\n').replace(/(^|\n) {2}/g, '\n')
      .replace(/\$(\w+)\$/g, function (m0, m1){
        switch (m1) {
          case 'file':
            return path.relative(self.options.input, filename);
          case 'lines':
            return JSON.stringify(lines);
          case 'conds':
            return JSON.stringify(conds);
          case 'source':
            return JSON.stringify(data.toString().split(/\r?\n/));
        }
      });


    basenode.body = UglifyJS.parse(ff).body.concat(basenode.body);
  }

  // TODO this should be moved to a better place

  (function nextDep(i) {
    var dep = dependencies[i];

    if (!dep) {
      dependencies = _.uniq(dependencies, null, function (item) {
        return item.type + '-' + item.path;
      });
      return callback(null, dependencies);
    }

    var fullBaseName = filename.split('/');
    fullBaseName.pop();
    fullBaseName = fullBaseName.join('/');

    debug('Resolving full path for %s %s', fullBaseName, dep.path);
    self._resolveFileName(path.relative(self.options.input, fullBaseName), dep.path, function (err, fpath) {
      if (err) {
        debug(err);
        return nextDep(++i);
      }

      debug('Resolved full path for %s %s = ', fullBaseName, dep.path, fpath);
      dep.item.value = self._cleanPath(fpath).replace(/\.js$/, '');
      nextDep(++i);
    });
  })(0);
};

Sear.prototype._getFileContent = function (base, filepath, callback) {
  debug('Getting file contents %s %s', base, filepath);
  this._resolveFileName(base, filepath, function (err, path) {
    if (err || !path) {
      if (!err) {
        err = new Error('No such path');
        err.base = base;
        err.path = path;
        err.code = 404;
      }
      return callback(err);
    }

    fs.stat(path, function (err, stat) {
      fs.readFile(path, function (err, data) {
        callback(err, data, path, stat && stat.mtime ? stat.mtime : 0);
      });
    });
  });
};

Sear.prototype._toAST = function (data, filename, callback) {
  debug('Converting source to AST');
  var ast;
  try {
    ast = UglifyJS.parse(data.toString(), {
      html5_comments: true,
      filename: path.relative(this.options.input, filename)
    });
  } catch (e) {
    return callback(e);
  }

  callback(null, ast);
};

Sear.prototype.loadFile = function (base, filepath, callback) {
  if (arguments.length === 2) {
    callback = filepath;
    filepath = base;
    base = '';
  }

  debug('Loading file %s %s', base, filepath);

  var self = this;

  this._getFileContent(base, filepath, function (err, data, filename, modified) {
    if (err) {
      return callback(err);
    }

    self._transform(filename, data, function (err, data, sourcemap) {
      if (err) {
        return callback(err);
      }

      self._toAST(data, filename, function (err, ast) {
        if (err) {
          return callback(err);
        }

        self._walk(base, filepath, ast, filename, data, function (err, dependencies) {
          if (err) {
            return callback(err);
          }

          self._wrap({
            orig_sourcemap: sourcemap,
            base: base,
            relative_path: filepath,
            path: filename,
            ast: ast,
            content: data,
            dependencies: dependencies,
            modified: modified
          }, function (err, details) {
            if (err) {
              return callback(err);
            }

            callback(null, new SearFile(self, details));
          });
        });
      });
    });
  });
};

Sear.prototype._isPackage = function (base, filepath, callback) {
  this._resolve(base, filepath, function (err, file) {
    if (file && (file.indexOf(this.options.node_modules) > -1 ||
    file.indexOf(this.options.bower_components)) > -1) {
      return callback(null, true, this._cleanPath(path.relative(this.options.input, file)));
    }

    callback(null, false);
  }.bind(this));
};

Sear.prototype._resolveFileName = function (base, filepath, cb) {
  var self = this;

  var fullPath = path.join(base, filepath);
  if (this.filePaths[fullPath]) {
    return cb(null, this.filePaths[fullPath]);
  }

  function callback(err, path) {
    self.filePaths[fullPath] = path;
    cb(err, path);
  }

  this._isPackage('', filepath, function (err, isPackage, path) {
    if (isPackage) {
      base = '';
    }

    this._resolve(base, filepath, function (err, path) {
      if (err && err.message.indexOf('Cannot find module ') === 0 && (filepath.indexOf('.') !== 0 && !base)) {

        if (filepath.indexOf('/') === -1) {
          filepath = '/' + filepath;
        }

        filepath = '.' + filepath;


        return this._resolveFileName(base, filepath, callback);
      } else if (err) {
        err.code = err.message.indexOf('Cannot find module ') === 0 ? 404 : 0;

        if (err.code === 404 && base && !base.match(/\/$/)) {
          return this._resolve(base + '/', filepath, function (err, path) {
            if (err) {
              err.code = err.message.indexOf('Cannot find module ') === 0 ? 404 : 0;
            }

            callback(err, path);
          }.bind(this));
        }
      }

      callback(err, path);
    }.bind(this));
  }.bind(this));
};

Sear.prototype._getAssetDirs = function (callback) {
  var self = this;

  if (this._assetDirs) {
    return callback(null, this._assetDirs);
  }

  var dirs = [];

  if (this.options.assets) {
    dirs.push(path.resolve(path.join(this.options.input, this.options.assets)));
  }
  var moduleDirs = [this.options.bower_components, this.options.node_modules];

  (function nextModuleDir(x) {
    var moduleDir = moduleDirs[x];
    if (!moduleDir) {
      self._assetDirs = dirs;
      return callback(null, dirs);
    }

    fs.exists(moduleDir + '/', function (exists) {
      if (!exists) {
        return callback(null, dirs);
      }

      fs.readdir(moduleDir + '/', function (err, components) {
        if (err) {
          return callback(err);
        }

        (function nextComponent(i) {
          var component = components[i];

          if (!component) {
            return nextModuleDir(++x);
          }

          fs.exists(moduleDir + '/' + component + '/sear.json', function (exists) {
            if (!exists) {
              return nextComponent(++i);
            }

            fs.readFile(moduleDir + '/' + component + '/sear.json', function (err, data) {
              if (err) {
                return callback(err);
              }

              var config = JSON.parse(data.toString());
              if (config.assets) {
                dirs.push(
                  path.resolve(path.join(moduleDir + '/' + component, config.input, config.assets))
                );
              }
              nextComponent(++i);
            });
          });
        })(0);
      });
    });

  })(0);
};

Sear.prototype._generateId = function (callback) {
  var self = this;

  if (this._id) {
    return callback(null, this._id);
  }

  exec('git rev-list -1 HEAD', function (e, stdout) {
    if (e) {
      return callback(e);
    }
    var rev = stdout.replace(/\s/g, '');
    self._id = rev ? rev : Date.now();
    callback(null, self._id);
  });
};

Sear.prototype.getIndex = function (options) {
  if (this._index) {
    return this._index;
  }

  options = _.extend({}, this.options, options);
  var index;
  if (this.options.index) {
    index = path.join(this.options.input, this.options.index);
  } else if (this.options.gen_index) {
    // generate index file
    index = require.resolve('./includes/index.html');
  }

  if (!index) {
    return null;
  }

  var data = fs.readFileSync(index);

  this._index = _.template(data.toString(), options);

  return this._index;
};

// Express app stuff

Sear.prototype._pushState = function (options) {
  var index;
  if (this.options.index) {
    index = path.join(this.options.input, this.options.index);
  }

  index = this.getIndex(options);

  return function (req, res, next) {
    if ('GET' !== req.method || !index) return next();
    res.send(index);
  };
};

Sear.prototype._staticAssets = function (options) {
  var self = this;
  var redirect = false !== options.redirect;

  return function (req, res, next) {
    if ('GET' !== req.method) return next();
    var path = url.parse(req.url).pathname;

    self._getAssetDirs(function (err, dirs) {
      if (err) {
        return next(err);
      }

      (function nextAssetDir(i) {
        var assetDir = dirs[i];
        if (!assetDir) {
          return next();
        }

        send(req, path)
          .maxage(options.maxAge || 0)
          .root(assetDir)
          .hidden(options.hidden)
          .on('error', function (err) {
            if (404 === err.status) return nextAssetDir(++i);
            next(err);
          })
          .on('directory', function () {
            nextAssetDir(++i);
          })
          .pipe(res);

      })(0);
    });
  };
};

Sear.prototype._loader = function (options) {
  var self  = this;

  var files = {};
  var fileWatcher = options.file_watcher;

  fileWatcher.on('update', function (cleanFilename) {
    debug('Removing %s from cache', cleanFilename);
    delete files[cleanFilename];

    if (cleanFilename.match(/\.macro$/) &&
      require.cache[path.join(options.input, cleanFilename)]) {
      delete require.cache[path.join(options.input, cleanFilename)];
    }
  });

  function getFileName(pathname) {
    return pathname.replace(/\.raw$/, '').replace(/\.map$/, '').replace(/\.js$/, '');
  }

  function isRawFileRequest(pathname) {
    return !!pathname.match(/\.raw$/);
  }

  function isMapFileRequest(pathname) {
    return !!pathname.match(/\.map$/);
  }

  function loadFile(filename, filepath, callback) {
    var cleanFilename = self._cleanPath(filepath);

    var file = files[cleanFilename];

    function bakeFile() {
      self.loadFile('', filename, function (err, file) {
        if (err) {
          return callback(err);
        }

        fileWatcher.subscribe(filepath);
        files[cleanFilename] = file;

        callback(null, file);
      });
    }

    if (file) {
      callback(null, file);
    } else {
      bakeFile();
    }
  }

  return function (req, res, next) {
    if ('GET' !== req.method) return next();
    var pathname = url.parse(req.url).pathname;

    if (pathname === '/') {
      return next();
    }

    var filename = getFileName(pathname);

    self._resolveFileName('', filename, function (err, path) {
      if (err) {
        if (err.code === 404) {
          if (req.query.amd) {
            console.log('Module ' + err.base + ' ' + err.path + ' could not be resolved.\n' +
            'If it is a package you might need to install it trough bower or npm.');
            return next(err);
          }
          return next();
        }
        return next(err);
      }

      if (!path) {
        return next();
      }

      if (isRawFileRequest(pathname)) {
        debug('Sending raw version of %s', pathname);
        res.sendfile(path);
        return;
      }

      options = _.extend({}, options, {
        add_includes: filename.substring(1) === options.name,
        add_load:  filename.substring(1) === options.name,
        sourceFile: pathname.replace(/\.map$/, '')
      });

      loadFile(filename, path, function (err, file) {
        if (err) {
          return next(err);
        }

        var output;

        if (isMapFileRequest(pathname)) {
          output = file.outputSourceMap(options);
        } else {
          output = file.output(options);
        }

        var filedata = "";

        es.pipeline(
          output,
          es.through(function write(data) {
              filedata += data.toString();
              this.emit('data', data);
            },
            function end () {
              res.writeHead(200, {
                'content-length': Buffer.byteLength(filedata, 'utf-8'),
                'content-type': "text/javascript",
                'X-SourceMap': !isMapFileRequest(pathname) ? (pathname + '.map') : null
              });

              debug('Returning loaded file', pathname);

              res.end(filedata);
              this.emit('end');
            })
        );
      });
    });

  };
};

Sear.prototype._getVersion = function () {
  var file = fs.readFileSync(process.cwd() + '/package.json');
  var pkg;
  try {
    pkg = JSON.parse(file);
  } catch (e) {
    console.log('package.json not found ' + file);
  }

  return pkg.version;
};

Sear.prototype._getReleaseVersion = function (dir) {
  var file = process.cwd() + dir + '/version';
  try {
    return fs.readFileSync(file).toString();
  } catch (e) {
    console.log('version file not found ' + file);
  }
};

Sear.prototype._serveIndex = function (req, res, options) {
  var head = req.method === 'HEAD';

  var file = path.join(process.cwd() + options.release_path, 'index.html');
  var index = this._cachedIndex = this._cachedIndex || {
    date: new Date(),
    data: fs.readFileSync(file),
    stat: fs.statSync(file)
  };
  if (!res.getHeader('ETag')) res.setHeader('ETag',
    '"' + index.stat.size + '-' + Number(index.stat.mtime) + '"');
  if (!res.getHeader('Date')) res.setHeader('Date', new Date().toUTCString());
  if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control',
    'public, max-age=' + (options.indexMaxAge / 1000));
  if (!res.getHeader('Last-Modified')) res.setHeader('Last-Modified',
    index.stat.mtime.toUTCString());
  if (!res.getHeader('Content-Type')) res.setHeader('Content-Type',
    'text/html; charset=UTF-8');

  res.setHeader('Content-Length', index.data.length);

  if (head) return res.end();

  res.send(index.data);
};

Sear.prototype.getExpressApp = function (options, ready) {
  var self = this;

  var app = express();
  this.fileWatcher = app.fileWatcher = new FileWatcher(this, options);
  var server = http.createServer(app);

  options = _.extend({
    indexMaxAge: 15 * 60000,
    assets_mount: '/assets',
    release_path: '/release',
    file_watcher: this.fileWatcher
  }, this.options, options || {});

  app.use(function (req, res, next) {

    debug('%s: %s', req.method, req.url);
    next();
  });

  if (!options.use_release) {

    if (options.live_update) {
      this.updateServer = app.updateServer = new UpdateServer(
        this, this.fileWatcher, options.server || server, options);
    }

    app.use(options.assets_mount, this._staticAssets(options));
    app.use(this._loader(options));
    app.use(this._pushState(options));
  } else {
    var version = this._getVersion();
    var releaseVersion = this._getReleaseVersion(options.release_path);

    if (version !== releaseVersion) {
      console.log('Product version doesn\'t match the last released version');
    }

    app.use(function (req, res, next) {
      req.pathname = url.parse(req.url).pathname;
      next();
    });

    app.use(function (req, res, next) {
      if ('GET' !== req.method && 'HEAD' !== req.method) return next();
      var path = req.pathname;
      if (path === "/index.html" || path === "/") {
        // Serve index without cache
        self._serveIndex(req, res, options);
      } else {
        next();
      }
    });

    app.use(function (req, res, next) {
      if ('GET' !== req.method && 'HEAD' !== req.method) return next();
      var path = req.pathname;

      send(req, path)
        .maxage(options.maxAge || 0)
        .root(process.cwd() + options.release_path)
        .hidden(options.hidden)
        .on('error', function (err) {
          if (404 === err.status) return next();
          next(err);
        })
        .on('directory', function () {
          next();
        })
        .pipe(res);
    });

    app.use(function (req, res, next) {
      if ('GET' !== req.method && 'HEAD' !== req.method) return next();
      // Push state
      self._serveIndex(req, res, options);
    });
  }

  app.use(function(err, req, res, next){
    if (process.env.NODE_ENV !== 'production' && req.query.amd) {
      return res.send('throw ' + JSON.stringify(err.stack || String(err)) + ';');
    }

    next(err);
  });

  if (ready) {
    process.nextTick(ready);
  }

  app.listen = function () {
    server.listen.apply(server, arguments);
  };

  return app;
};

module.exports = Sear;
