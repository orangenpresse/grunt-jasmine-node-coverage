module.exports = function(grunt) {
    'use strict';

    var doCoverage = function(opts, projectRoot, runFn) {
        var istanbul = require('istanbul'),
            Path = require('path'),
            mkdirp = require('mkdirp'),
            fs = require('fs'),
            glob = require('glob');

        // set up require hooks to instrument files as they are required
        var DEFAULT_REPORT_FORMAT = 'lcov';
        var Report = istanbul.Report;
        var reports = [];
        var savePath = opts.savePath || 'coverage';
        var reportingDir = Path.resolve(process.cwd(), savePath);
        mkdirp.sync(reportingDir); //ensure we fail early if we cannot do this
        var reportClassNames = opts.report || [DEFAULT_REPORT_FORMAT];
        reportClassNames.forEach(function(reportClassName) {
            reports.push(Report.create(reportClassName, {
                dir: reportingDir
            }));
        });
        if (opts.print !== 'none') {
            switch (opts.print) {
                case 'detail':
                    reports.push(Report.create('text'));
                    break;
                case 'both':
                    reports.push(Report.create('text'));
                    reports.push(Report.create('text-summary'));
                    break;
                default:
                    reports.push(Report.create('text-summary'));
                    break;
            }
        }

        var excludes = opts.excludes || [];
        excludes.push('**/node_modules/**');

        istanbul.
        matcherFor({
                root: projectRoot || process.cwd(),
                includes: ['**/*.js'],
                excludes: excludes
            },
            function(err, matchFn) {
                if (err) {
                    return callback(err);
                }

                var coverageVar = '$$cov_' + new Date().getTime() + '$$',
                    instrumenter = new istanbul.Instrumenter({
                        coverageVariable: coverageVar
                    }),
                    transformer = instrumenter.instrumentSync.bind(instrumenter),
                    hookOpts = {
                        verbose: opts.isVerbose
                    };

                istanbul.hook.hookRequire(matchFn, transformer, hookOpts);

                //initialize the global variable to stop mocha from complaining about leaks
                global[coverageVar] = {};

                process.once('exit', function() {
                    var file = Path.resolve(reportingDir, 'coverage.json'),
                        collector,
                        cov;
                    if (typeof global[coverageVar] === 'undefined' || Object.keys(global[coverageVar]).length === 0) {
                        console.error('No coverage information was collected, exit without writing coverage information');
                        return;
                    } else {
                        cov = global[coverageVar];
                    }
                    //important: there is no event loop at this point
                    //everything that happens in this exit handler MUST be synchronous
                    mkdirp.sync(reportingDir); //yes, do this again since some test runners could clean the dir initially created
                    if (opts.print !== 'none') {
                        console.error('=============================================================================');
                        console.error('Writing coverage object [' + file + ']');
                    }
                    fs.writeFileSync(file, JSON.stringify(cov), 'utf8');
                    collector = new istanbul.Collector();
                    if (opts.collect != null) {
                        opts.collect.forEach(function(covPattern) {
                            var coverageFiles = glob.sync(covPattern, null);
                            coverageFiles.forEach(function(coverageFile) {
                                var contents = fs.readFileSync(coverageFile, 'utf8');
                                var fileCov = JSON.parse(contents);
                                if (opts.relativize) {
                                    var cwd = process.cwd();
                                    var newFileCov = {};
                                    for (var key in fileCov) {
                                        var item = fileCov[key];
                                        var path = item.path;
                                        var relPath = Path.relative(cwd, path);
                                        item.path = relPath;
                                        newFileCov[relPath] = item;
                                    }
                                    fileCov = newFileCov;
                                }
                                collector.add(fileCov);
                            });
                        })
                    } else {
                        collector.add(cov);
                    }
                    if (opts.print !== 'none') {
                        console.error('Writing coverage reports at [' + reportingDir + ']');
                        console.error('=============================================================================');
                    }
                    reports.forEach(function(report) {
                        report.writeReport(collector, true);
                    });

                    // Check against thresholds
                    collector.files().forEach(function(file) {
                        var summary = istanbul.utils.summarizeFileCoverage(
                            collector.fileCoverageFor(file));
                        grunt.util._.each(opts.thresholds, function(threshold, metric) {
                            var actual = summary[metric];
                            if (!actual) {
                                grunt.warn('unrecognized metric: ' + metric);
                            }
                            if (actual.pct < threshold) {
                                grunt.warn('expected ' + metric + ' coverage to be at least ' + threshold + '% but was ' + actual.pct + '%' + '\n\tat (' + file + ')');
                            }
                        });
                    });

                });
                runFn();
            });

    };

    grunt.registerMultiTask("jasmine_node", "Runs jasmine-node.", function() {
        var jasmine = require('jasmine-node');
        var util;
        try {
            util = require('util');
        } catch (e) {
            util = require('sys');
        }

        var options = this.options({
            specFolders: [],
            projectRoot: '',
            match: '.',
            matchall: false,
            specNameMatcher: 'spec',
            helperNameMatcher: 'helpers',
            extensions: 'js',
            showColors: true,
            includeStackTrace: true,
            useHelpers: false,
            teamcity: false,
            coffee: false,
            verbose: false,
            jUnit: {
                report: false,
                savePath: "./reports/",
                useDotNotation: true,
                consolidate: true
            },
            coverage: {
                enable: false,
                report: 'lcov',
                savePath: "./coverage/",
                print: 'both',
                excludes: [],
                collect: null,
                relativize: false,
                thresholds: []
            },
            growl: false
        });
        options.specFolders = grunt.util._.union(options.specFolders, this.filesSrc);
        if (options.projectRoot) {
            options.specFolders.push(options.projectRoot);
        }
        // Tell grunt this task is asynchronous.
        var done = this.async();

        if (options.coffee) {
            options.extensions = 'js|coffee|litcoffee';
            require('coffee-script');
        }
        var regExpSpec = new RegExp(options.match + (options.matchall ? "" : options.specNameMatcher + "\\.") + "(" + options.extensions + ")$", 'i');

        var onComplete = function(runner, log) {
            var exitCode;
            util.print('\n');
            if (runner.results().failedCount === 0) {
                exitCode = 0;
            } else {
                exitCode = 1;

                if (options.forceExit) {
                    process.exit(exitCode);
                }
            }
            jasmine.getGlobal().jasmine.currentEnv_ = undefined;
            done(exitCode === 0);
        };

        if (options.useHelpers) {
            this.filesSrc.forEach(function(path) {
                jasmine.loadHelpersInFolder(path, new RegExp(options.helperNameMatcher + "?\\.(" + options.extensions + ")$", 'i'));
            });
        }

        var jasmineOptions = {
            specFolders: options.specFolders,
            onComplete: onComplete,
            isVerbose: grunt.verbose ? true : options.verbose,
            showColors: options.showColors,
            teamcity: options.teamcity,
            useRequireJs: options.useRequireJs,
            regExpSpec: regExpSpec,
            junitreport: options.jUnit,
            includeStackTrace: options.includeStackTrace,
            coffee: options.coffee,
            growl: options.growl
        };

        var self = this;
        var runFn = function() {
            try {
                // for jasmine-node@1.0.27 individual arguments need to be passed
                // order is preserved in node.js
                var legacyArguments = Object.keys(options).map(function(key) {
                    return options[key];
                });
                jasmine.executeSpecsInFolder.apply(self, legacyArguments);
            } catch (e) {
                try {
                    // since jasmine-node@1.0.28 an options object need to be passed
                    jasmine.executeSpecsInFolder(jasmineOptions);
                } catch (e) {
                    console.log('Failed to execute "jasmine.executeSpecsInFolder": ' + e.stack);
                }
            }
        };

        if (options.coverage.enable === true) {
            options.coverage.isVerbose = jasmineOptions.isVerbose;
            doCoverage(options.coverage, options.projectRoot, runFn);
        } else {
            runFn();
        }

    });
};