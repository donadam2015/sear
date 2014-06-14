var fs = require('fs');
var path = require('path');
var _ = require('lodash');
var spawn = require('child_process').spawn;

var requiredIncludes = [
  'mocha',
  'bower_components/chai/chai'
];

function checkDeps(callback) {
  var self = this;

  var deps = _.union(requiredIncludes.map(function (name) {
    return {
      name: name,
      pm: 'bower'
      }
    }), [
    'sear-require',
    'function-bind'
    ].map(function (name) {
      return {
        name: name,
        pm: 'npm'
      }
    })).map(function (dep) {
      dep.include = dep.name;
      if (dep.name !== '/') {
        dep.name =  dep.name.split('/')[0];
      }
      return dep;
    });

  var missing = [];

  (function checkDep(i) {
    var dep = deps[i];
    if (dep == null) {
      return callback(null, missing);
    }

    self._resolveFileName('', dep.include, function (err, path) {
      if (!path || err) {
        missing.push(dep);
      }

      checkDep(++i);
    });

  })(0);
}

module.exports = function (files, options, callback) {
  var self = this;
  function runTests() {
    var testFiles = [];

    function readFiles(files, base) {
      _.each(files, function (file) {
        var stat = fs.statSync(path.join(base, file));
        if (stat.isDirectory() && options.recursive) {
          readFiles(fs.readdirSync(path.join(base, file)), path.join(base, file));
        } else if (stat.isFile() && self.extensions[path.extname(file).substr(1)]){
          testFiles.push(path.relative(path.resolve(options.input), path.join(base, file)));
        }
      });
    }

    readFiles(files, options.input);

    testFiles = _.uniq(testFiles);

    var testSuiteFile = 'Function.prototype.bind = require(\'function-bind\');\n';

    var testOptions = options.testOptions || {ui: 'bdd', grep: process.env.GREP};

    if (typeof testOptions !== 'string') {
      testOptions = JSON.stringify(testOptions);
    }

    testSuiteFile += 'mocha.setup(' + testOptions + ');\n';

    _.each(testFiles, function (file) {
      testSuiteFile += 'require(\'./' + file + '\')\n';
    });

    testSuiteFile += 'if (window.mochaPhantomJS) {\n';
    testSuiteFile += ' mochaPhantomJS.run();\n';
    testSuiteFile += '} else {\n';
    testSuiteFile += '  mocha.run();\n';
    testSuiteFile += '}\n';

    fs.writeFileSync(path.join(options.input, 'temptestsuite.js'), testSuiteFile);

    var testSuiteIndex = '';
    testSuiteIndex += '<!DOCTYPE html>\n';
    testSuiteIndex += '<html>\n';
    testSuiteIndex += '<head>\n';
    testSuiteIndex += '<meta charset="UTF-8">\n';
    testSuiteIndex += '<title>Sear test suite</title>\n';
    testSuiteIndex += '</head>\n';
    testSuiteIndex += '<body>\n';
    testSuiteIndex += '<div id="mocha"></div>\n';
    testSuiteIndex += '<script type="text/javascript" src="temptestsuite.js"></script>\n';
    testSuiteIndex += '</body>\n';
    testSuiteIndex += '</html>\n';

    fs.writeFileSync(path.join(options.input, 'temptestsuite.html'), testSuiteIndex);

    options.name = 'temptestsuite';
    options.index = 'temptestsuite.html';
    options.target = 'temptestsuite/';
    options.minify = false;
    options.includes = options.includes || [];

    options.includes = _.union(requiredIncludes, options.includes, ['sear-require']);

    self.commands.build([], options, function (err) {
      if (err) {
        return callback(err);
      }

      var mocha = spawn(
        path.join(__dirname, '../../../node_modules/.bin/mocha-phantomjs'),
        ['temptestsuite/index.html']);

      mocha.stdout.pipe(process.stdout, { end: false });
      mocha.stderr.pipe(process.stderr, { end: false });

      mocha.on('close', function (code) {
        process.exit(code);
      });
    });
  }

  checkDeps.call(this, function (err, missing) {
    if (err) {
      return callback(err);
    }

    if (missing.length > 0) {
      console.log("Following dependencies need to be installed before testsuite can be run");
      _.each(missing, function (pack) {
        console.log(pack.name, '-', pack.pm, 'install', pack.name,'--save-dev');
      });
      callback(new Error("Missing dependencies see stdout"));
    } else {
      runTests();
    }
  });

};