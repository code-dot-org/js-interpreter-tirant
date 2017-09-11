import path from 'path';
import fetch from 'node-fetch';
import os from 'os';
import fs from 'fs';
import yargs from 'yargs';
import {execSync} from 'child_process';
import chalk from 'chalk';
import globber from 'test262-harness/lib/globber.js';
import ProgressBar from 'progress';
import runner from './runner';

const TEST_TYPES = ['es5', 'es6', 'es', 'other'];

const ARGS = yargs
  .usage(`Usage: $0 [options] [test file glob pattern]`)
  .alias('d', 'diff')
  .describe(
    'd',
    'diff against existing test results. Returns exit code 1 if there are changes.'
  )
  .boolean('d')
  .alias('r', 'run')
  .describe('r', 'generate new test results')
  .boolean('r')
  .describe('splitInto', 'Only run 1/N tests')
  .nargs('splitInto', 1)
  .describe('splitIndex', 'Which 1/N tests to run')
  .nargs('splitIndex', 1)
  .alias('s', 'save')
  .describe('s', 'save the results')
  .boolean('s')
  .alias('t', 'threads')
  .describe('t', '# of threads to use')
  .nargs('t', 1)
  .default('t', os.cpus().length)
  .describe('progress', 'display a progress bar')
  .alias('v', 'verbose')
  .boolean('v')
  .describe(
    'root',
    'Root directory where test262 suite and test results are kept'
  )
  .default('root', 'tyrant')
  .describe('compiledOut', 'Directory to dump compiled test files to')
  .nargs('compiledOut', 1)
  .describe('savedResults', 'Specify a results file to compare and/or save to')
  .nargs('savedResults', 1)
  .alias('i', 'input')
  .describe('i', 'Specify a results file')
  .nargs('i', 1)
  .describe('circleBuild', 'specify a circle build to download results from')
  .nargs('circleBuild', 1)
  .nargs('interpreter', 1)
  .describe('interpreter', 'path to interpreter module to use')
  .describe('hostPath', 'path to the js-interpreter run script')
  .nargs('hostPath', 1)
  .describe('rerun', 'reruns tests that have regressed')
  .boolean('rerun')
  .describe('retries', 'number of times to retry regressed tests')
  .nargs('retries', 1)
  .help('h')
  .alias('h', 'help');

export default class Tyrant {
  constructor(argv) {
    if (!argv) {
      argv = ARGS.argv;
    } else if (Array.isArray(argv)) {
      argv = ARGS.parse(argv);
    }
    argv.input = argv.input || path.resolve(argv.root, 'test-results-new.json');
    argv.savedResults =
      argv.savedResults || path.resolve(argv.root, 'test-results.json');

    if (argv.rerun || argv.retries) {
      argv.diff = true;
    }

    this.argv = argv;

    this.RESULTS_FILE = path.resolve(this.argv.input);
    this.RESULTS_DIFF_FILE = path.resolve(
      this.argv.root,
      'test-results-diff.json'
    );
    this.VERBOSE_RESULTS_FILE = path.resolve(
      this.argv.root,
      'test-results-new.verbose.json'
    );
    this.numTries = 1;
    this.OLD_RESULTS_BY_KEY = this.argv.diff
      ? this.getResultsByKey(
          readResultsFromFile(
            typeof this.argv.diff === 'string'
              ? this.argv.diff
              : this.argv.savedResults
          )
        )
      : {};
    console.log('done constructing');
  }

  execute = () => {
    if (this.argv.run) {
      this.runTests(this.RESULTS_FILE, this.VERBOSE_RESULTS_FILE).then(
        this.postRun
      );
    } else if (this.argv.circleBuild) {
      this.downloadCircleResults().then(this.processTestResults);
    } else if (this.argv.rerun) {
      this.rerun().then(this.processTestResults);
    } else {
      this.processTestResults();
    }
  };

  rerun = () => {
    const {testsThatDiffer} = this.getResultsDiff(
      readResultsFromFile(this.RESULTS_FILE)
    );
    if (this.argv._.length === 0) {
      this.argv._ = testsThatDiffer.regressions.map(({newTest}) =>
        this.getNormalizedTestFileName(newTest.file)
      );
      console.log('found', this.argv._.length, 'regressions to rerun');
    } else {
      const possibleFiles = new Set(this.argv._.map(fn => path.resolve(fn)));
      this.argv._ = testsThatDiffer.regressions
        .map(({newTest}) => this.getNormalizedTestFileName(newTest.file))
        .filter(fn => possibleFiles.has(fn));
    }
    if (this.argv._.length > 0) {
      execSync(`cp ${this.RESULTS_FILE} ${this.RESULTS_FILE}.old.json`);
      return this.runTests(this.RESULTS_FILE, this.VERBOSE_RESULTS_FILE);
    } else {
      console.log('nothing to rerun, there were no regressions');
    }
    return Promise.resolve();
  };

  postRun = () => {
    if (this.argv.retries) {
      let results = readResultsFromFile(this.RESULTS_FILE);
      let {testsThatDiffer} = this.getResultsDiff(results);
      const numTriesLeft = this.argv.retries - this.numTries;
      if (testsThatDiffer.regressions.length > 0 && numTriesLeft > 0) {
        console.log(
          `got ${testsThatDiffer.regressions
            .length} regressions. Retrying them ${numTriesLeft > 1
            ? 'up to '
            : ''}${numTriesLeft} ${numTriesLeft > 1
            ? 'more times...'
            : 'more time...'}`
        );
        this.numTries++;
        return this.rerun().then(this.postRun);
      }
    }
    this.processTestResults();
  };

  processTestResults = () => {
    let results = readResultsFromFile(this.RESULTS_FILE);
    if (this.argv.rerun) {
      console.log('merging results from rerun:');
      this.printAndCheckResultsDiff(results);
      // this was a rerun, so merge the old and new results together
      const allResults = this.getResultsByKey(
        readResultsFromFile(this.RESULTS_FILE + '.old.json')
      );
      const newResultsByKey = this.getResultsByKey(results);
      Object.assign(allResults, newResultsByKey);
      results = Object.keys(allResults).map(key => allResults[key]);
      fs.writeFileSync(this.RESULTS_FILE, JSON.stringify(results, null, 2));
    }

    if (this.argv.save) {
      this.saveResults(results);
    }

    this.printResultsSummary(results);
    let hadRegressions = false;
    if (this.argv.diff) {
      hadRegressions = this.printAndCheckResultsDiff(results);
      fs.writeFileSync(
        this.RESULTS_DIFF_FILE,
        JSON.stringify(this.getResultsDiff(results))
      );
    }
    if (hadRegressions) {
      process.exit(1);
    }
  };

  printAndCheckResultsDiff = results => {
    const {
      testsThatDiffer,
      total,
      numNew,
      numFixes,
      numRegressions,
    } = this.getResultsDiff(results);
    if (this.argv.verbose) {
      const printTest = (color, {oldTest, newTest}, index) => {
        console.log(
          color(chalk.bold(`  ${index}. ${this.getTestDescription(newTest)}`))
        );
        console.log(chalk.gray(`     ${newTest.file}`));
        oldTest && console.log(`     - ${oldTest.result.message}`);
        console.log(`     + ${newTest.result.message}`);
      };
      console.log('\nNew:');
      testsThatDiffer.new.forEach(printTest.bind(null, chalk.green));
      console.log('Fixes:');
      testsThatDiffer.fixes.forEach(printTest.bind(null, chalk.green));
      console.log('\nRegressions:');
      testsThatDiffer.regressions.forEach(printTest.bind(null, chalk.red));
    }
    console.log('New:');
    TEST_TYPES.forEach(type => {
      if (total[type]) {
        console.log(`  ${type}: ${numNew[type]}/${total[type]}`);
      }
    });
    console.log('Fixes:');
    TEST_TYPES.forEach(type => {
      if (total[type]) {
        console.log(`  ${type}: ${numFixes[type]}/${total[type]}`);
      }
    });
    console.log('Regressions:');
    TEST_TYPES.forEach(type => {
      if (total[type]) {
        console.log(`  ${type}: ${numRegressions[type]}/${total[type]}`);
      }
    });

    for (let i = 0; i < TEST_TYPES.length; i++) {
      const type = TEST_TYPES[i];
      if (numRegressions[type]) {
        return true;
      }
    }
    return false;
  };

  getNormalizedTestFileName = filename => {
    return path.resolve(
      this.argv.root,
      'test262' + filename.split('test262')[1]
    );
  };

  getKeyForTest = test => {
    return [test.file.split('test262')[1], test.attrs.description].join(' ');
  };

  getResultsByKey = results => {
    const byKey = {};
    results.forEach(test => (byKey[this.getKeyForTest(test)] = test));
    return byKey;
  };

  getTestType = test => {
    return test.attrs.es5id
      ? 'es5'
      : test.attrs.es6id ? 'es6' : test.attrs.esid ? 'es' : 'other';
  };

  getTestDescription = test => {
    return (
      `[${this.getTestType(test)}] ` +
      (test.attrs.description || test.file).trim().replace('\n', ' ')
    );
  };

  printResultsSummary = results => {
    let total = {};
    let passed = {};
    let percent = {};

    results.forEach(test => {
      const type = this.getTestType(test);
      if (!total[type]) {
        total[type] = 0;
        passed[type] = 0;
      }
      total[type]++;
      if (test.result.pass) {
        passed[type]++;
      }
      percent[type] = Math.floor(passed[type] / total[type] * 100);
    });

    console.log('Results:');
    TEST_TYPES.forEach(type => {
      if (total[type]) {
        console.log(
          `  ${type}: ${passed[type]}/${total[type]} (${percent[type]}%) passed`
        );
      }
    });
  };

  getTestDiff = newTest => {
    const oldTest = this.OLD_RESULTS_BY_KEY[this.getKeyForTest(newTest)];
    return {
      isRegression: oldTest && oldTest.result.pass && !newTest.result.pass,
      isFix: oldTest && !oldTest.result.pass && newTest.result.pass,
      isNew: !oldTest,
    };
  };

  getResultsDiff = results => {
    const testsThatDiffer = {regressions: [], fixes: [], other: [], new: []};
    let numRegressions = {};
    let numFixes = {};
    let numNew = {};
    let total = {};
    results.forEach(newTest => {
      const type = this.getTestType(newTest);
      if (!total[type]) {
        total[type] = 0;
        numRegressions[type] = 0;
        numFixes[type] = 0;
        numNew[type] = 0;
      }
      total[type]++;
      const oldTest = this.OLD_RESULTS_BY_KEY[this.getKeyForTest(newTest)];
      let diffList = testsThatDiffer.other;
      const testDiff = this.getTestDiff(newTest);
      if (testDiff.isRegression) {
        numRegressions[this.getTestType(newTest)]++;
        diffList = testsThatDiffer.regressions;
      } else if (testDiff.isFix) {
        numFixes[this.getTestType(newTest)]++;
        diffList = testsThatDiffer.fixes;
      } else if (testDiff.isNew) {
        numNew[this.getTestType(newTest)]++;
        diffList = testsThatDiffer.new;
      }
      diffList.push({oldTest, newTest});
    });
    return {testsThatDiffer, total, numNew, numFixes, numRegressions};
  };

  downloadCircleResults = () => {
    console.log('downloading test results from circle ci...');
    const VCS_TYPE = 'github';
    const USERNAME = 'code-dot-org';
    const PROJECT = 'JS-Interpreter';
    const REQUEST_PATH = `https://circleci.com/api/v1.1/project/${VCS_TYPE}/${USERNAME}/${PROJECT}/${this
      .argv.circleBuild}/artifacts`;

    return fetch(REQUEST_PATH)
      .then(res => res.json())
      .then(artifacts =>
        artifacts
          .filter(a => a.pretty_path.endsWith('test-results-new.json'))
          .map(a => a.url)
      )
      .then(resultFileUrls => {
        const bar = new ProgressBar('[:bar] :current/:total', {
          curr: 0,
          total: resultFileUrls.length,
        });
        return Promise.all(
          resultFileUrls.map(url =>
            fetch(url).then(res => {
              bar.tick();
              return res.json();
            })
          )
        );
      })
      .then(results => {
        const allResults = results.reduce((acc, val) => acc.concat(val), []);
        allResults.sort(
          (a, b) => (a.file < b.file ? -1 : a.file === b.file ? 0 : 1)
        );
        fs.writeFileSync(this.argv.input, JSON.stringify(allResults, null, 2));
      });
  };

  runTests = (outputFilePath, verboseOutputFilePath) => {
    return new Promise(resolve => {
      const testGlobs = this.getTestGlobs();
      globber(testGlobs).toArray().subscribe(paths => {
        let globs = testGlobs;
        if (this.argv.splitInto) {
          // split up the globs in circle according to which container we are running on
          paths = paths
            .sort()
            .filter(
              (path, index) =>
                index % parseInt(this.argv.splitInto) ===
                parseInt(this.argv.splitIndex)
            );
          globs = paths;
        }
        console.log(
          `running around ${paths.length * 2} tests with ${this.argv
            .threads} threads...`
        );

        const bar = new ProgressBar(
          '[:bar] :current/:total :percent | :minutes left | R::regressed, F::fixed, N::new',
          {
            total: paths.length * 2, // each file gets run in strict and unstrict mode
            width: 50,
          }
        );

        let count = 1;
        const outputFile = fs.openSync(outputFilePath, 'w');
        let verboseOutputFile;
        if (this.argv.verbose) {
          verboseOutputFile = fs.openSync(verboseOutputFilePath, 'w');
        }
        let startTime;
        let running = false;
        fs.appendFileSync(outputFile, '[\n');
        if (verboseOutputFile) {
          fs.appendFileSync(verboseOutputFile, '[\n');
        }
        running = true;

        const finishWritingOutput = () => {
          fs.appendFileSync(outputFile, ']\n');
          fs.closeSync(outputFile);
          if (verboseOutputFile) {
            fs.appendFileSync(verboseOutputFile, ']\n');
            fs.closeSync(verboseOutputFile);
          }
        };
        process.on('SIGINT', () => {
          if (running) {
            console.log(
              chalk.bold(
                chalk.red(
                  '\n\nStopped before all tests were run. Results are not complete!'
                )
              )
            );
            finishWritingOutput();
          }
          this.processTestResults();
          process.exit(1);
        });
        runner.run({
          compiledFilesDir:
            this.argv.compiledOut && path.resolve(this.argv.compiledOut),
          threads: this.argv.threads,
          timeout: 60000,
          hostType: 'js-interpreter',
          hostPath:
            this.argv.hostPath ||
            path.resolve(__dirname, '../../../../js-interpreter/bin/run.js'),
          hostArgs: this.argv.interpreter
            ? ['--interpreter', this.argv.interpreter]
            : undefined,
          test262Dir: path.resolve(this.argv.root, 'test262'),
          reporter: results => {
            results.on('start', () => {
              startTime = new Date().getTime();
            });
            results.on('end', () => {
              if (running) {
                finishWritingOutput();
              }
              running = false;
              console.log(`\nfinished running ${count} tests`);
              resolve();
            });
            let numRegressed = 0;
            let numFixed = 0;
            let numNew = 0;
            results.on('test end', test => {
              test.file = fs
                .realpathSync(test.file)
                .replace(path.resolve(this.argv.root, '..') + '/', '');
              const color = test.result.pass ? chalk.green : chalk.red;
              const description = this.getTestDescription(test);
              const write = (...args) => {
                if (!this.argv.progress) {
                  process.stdout.write(...args);
                }
              };
              if (this.argv.diff) {
                const testDiff = this.getTestDiff(test);
                if (testDiff.isRegression) {
                  write('R');
                  numRegressed++;
                } else if (testDiff.isFix) {
                  write('F');
                  numFixed++;
                } else if (testDiff.isNew) {
                  write('N');
                  numNew++;
                } else {
                  write('.');
                }
              } else {
                write('.');
              }
              if (this.argv.verbose) {
                write(` ${count + 1} ${chalk.bold(color(description))}\n`);
                write(`   ${chalk.gray(test.file)}\n`);
                write(`   ${chalk.gray(test.result.message)}\n`);
              } else if (count % 80 === 0) {
                write('\n');
              }
              if (count > 1) {
                fs.appendFileSync(outputFile, ',\n');
                if (verboseOutputFile) {
                  fs.appendFileSync(verboseOutputFile, ',\n');
                }
              }

              fs.appendFileSync(
                outputFile,
                JSON.stringify(
                  {
                    file: test.file,
                    attrs: test.attrs,
                    result: test.result,
                  },
                  null,
                  2
                ) + '\n'
              );
              if (verboseOutputFile) {
                fs.appendFileSync(
                  verboseOutputFile,
                  JSON.stringify(test, null, 2) + '\n'
                );
              }

              count++;
              if (this.argv.progress) {
                let secondsRemaining =
                  (new Date().getTime() - startTime) /
                  bar.curr *
                  (bar.total - bar.curr) /
                  1000;
                let eta;
                if (secondsRemaining > 60) {
                  eta = `${Math.floor(secondsRemaining / 60)}m`;
                } else {
                  eta = `${Math.floor(secondsRemaining)}s`;
                }
                bar.tick(
                  // tick twice for tests that don't run in both strict and non-strict modes
                  !test.attrs.flags.onlyStrict &&
                  !test.attrs.flags.noStrict &&
                  !test.attrs.flags.raw
                    ? 1
                    : 2,
                  {
                    regressed: numRegressed,
                    fixed: numFixed,
                    new: numNew,
                    minutes: eta,
                  }
                );
              }
            });
          },
          globs: globs,
        });
      });
    });
  };

  saveResults = results => {
    console.log('Saving results for future comparison...');
    results = results.map(test => ({
      file: test.file,
      attrs: test.attrs,
      result: test.result,
    }));
    results.sort((a, b) => (a.file < b.file ? -1 : a.file === b.file ? 0 : 1));
    fs.writeFileSync(this.argv.savedResults, JSON.stringify(results, null, 2));
  };

  getTestGlobs = () => {
    return Array.from(
      new Set(
        this.argv._.length > 0
          ? this.argv._
          : [
              'test262/test/annexB/**/*.js',
              'test262/test/harness/**/*.js',
              'test262/test/intl402/**/*.js',
              'test262/test/language/**/*.js',
              'test262/test/built-ins/Array/**/*.js',
              'test262/test/built-ins/ArrayBuffer/**/*.js',
              'test262/test/built-ins/ArrayIteratorPrototype/**/*.js',
              'test262/test/built-ins/AsyncFunction/**/*.js',
              'test262/test/built-ins/Atomics/**/*.js',
              'test262/test/built-ins/Boolean/**/*.js',
              'test262/test/built-ins/DataView/**/*.js',
              'test262/test/built-ins/Date/**/*.js',
              'test262/test/built-ins/decodeURI/**/*.js',
              'test262/test/built-ins/decodeURIComponent/**/*.js',
              'test262/test/built-ins/encodeURI/**/*.js',
              'test262/test/built-ins/encodeURIComponent/**/*.js',
              'test262/test/built-ins/Error/**/*.js',
              'test262/test/built-ins/eval/**/*.js',
              'test262/test/built-ins/Function/**/*.js',
              'test262/test/built-ins/GeneratorFunction/**/*.js',
              'test262/test/built-ins/GeneratorPrototype/**/*.js',
              'test262/test/built-ins/global/**/*.js',
              'test262/test/built-ins/Infinity/**/*.js',
              'test262/test/built-ins/isFinite/**/*.js',
              'test262/test/built-ins/isNaN/**/*.js',
              'test262/test/built-ins/IteratorPrototype/**/*.js',
              'test262/test/built-ins/JSON/**/*.js',
              'test262/test/built-ins/Map/**/*.js',
              'test262/test/built-ins/MapIteratorPrototype/**/*.js',
              'test262/test/built-ins/Math/**/*.js',
              'test262/test/built-ins/NaN/**/*.js',
              'test262/test/built-ins/NativeErrors/**/*.js',
              'test262/test/built-ins/Number/**/*.js',
              'test262/test/built-ins/Object/**/*.js',
              'test262/test/built-ins/parseFloat/**/*.js',
              'test262/test/built-ins/parseInt/**/*.js',
              'test262/test/built-ins/Promise/**/*.js',
              'test262/test/built-ins/Proxy/**/*.js',
              'test262/test/built-ins/Reflect/**/*.js',
              'test262/test/built-ins/RegExp/**/*.js',
              'test262/test/built-ins/Set/**/*.js',
              'test262/test/built-ins/SetIteratorPrototype/**/*.js',
              'test262/test/built-ins/SharedArrayBuffer/**/*.js',
              'test262/test/built-ins/Simd/**/*.js',
              'test262/test/built-ins/String/**/*.js',
              'test262/test/built-ins/StringIteratorPrototype/**/*.js',
              'test262/test/built-ins/Symbol/**/*.js',
              'test262/test/built-ins/ThrowTypeError/**/*.js',
              'test262/test/built-ins/TypedArray/**/*.js',
              // this test file currently makes the interpreter explode.
              //  'test262/test/built-ins/TypedArrays/**/*.js',
              'test262/test/built-ins/undefined/**/*.js',
              'test262/test/built-ins/WeakMap/**/*.js',
              'test262/test/built-ins/WeakSet/**/*.js',
            ].map(t => path.resolve(this.argv.root, t))
      )
    );
  };
}

function readResultsFromFile(filename) {
  console.log('opening', path.resolve(filename));
  return JSON.parse(fs.readFileSync(path.resolve(filename)));
}
