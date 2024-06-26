'use strict';

import gulp from 'gulp';
import cleanCss from 'gulp-clean-css';
import gulpIf from 'gulp-if';
import imagemin, { mozjpeg } from 'gulp-imagemin';
import postcss from 'gulp-postcss';
import sourcemaps from 'gulp-sourcemaps';
import webp from 'gulp-webp';
import change from 'gulp-change';

import autoprefixer from 'autoprefixer';
import browser from 'browser-sync';
import fs from 'fs';
import rimraf from 'rimraf';
import yaml from 'js-yaml';
import named from 'vinyl-named';
import panini from 'panini';
import webpack2 from 'webpack';
import webpackStream from 'webpack-stream';
import npmYargs from 'yargs';
import { hideBin } from 'yargs/helpers';
const yargs = npmYargs(hideBin(process.argv));

import npmSass from 'sass';
import gulpSass from 'gulp-sass';
const pluginSass = gulpSass(npmSass);

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Check for --develop or --dev flag
const PRODUCTION = !(yargs.argv.develop || yargs.argv.dev);

// Check for --skip-compression flag
const SKIP_COMPRESSION = yargs.argv.skipCompression;

// Load config from config.yml
const { COMPATIBILITY, PORT, UNCSS_OPTIONS, PATHS } = loadConfig();

function loadConfig() {
  let ymlFile = fs.readFileSync('config.yml', 'utf8');
  return yaml.load(ymlFile);
}

function isCI() {
  return !!process.env.CI;
}

console.log('PRODUCTION: ', PRODUCTION);

// Build the "dist" folder by running all of the below tasks
// Sass must be run later so UnCSS can search for used classes in the others assets.
gulp.task(
  'build',
  gulp.series(
    clean,
    javascript,
    gulp.parallel(pages, images_minify, copy),
    images_webp,
    sass,
    AddEnglishSpecifier
  )
);

// Run the server, and watch for file changes
gulp.task('start-server', gulp.series(server, watch));

// Build the site, run the server, and watch for file changes
gulp.task('default', gulp.series('build', 'start-server'));

// Delete the "dist" folder
// This happens every time a build starts
function clean(done) {
  rimraf(PATHS.dist, done);
}

const folders = [PATHS.dist, PATHS.dist + '/.well-known'];

// Copy files out of the assets folder
// This task skips over the "img", "js", and "scss" folders, which are parsed separately
function copy() {
  folders.forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
      console.log('folder created:', dir);
    }
  });
  gulp.src(PATHS.rootAssets).pipe(gulp.dest(PATHS.dist));
  gulp.src(PATHS.wellKnown).pipe(gulp.dest(PATHS.dist + '/.well-known'));
  return gulp.src(PATHS.assets).pipe(gulp.dest(PATHS.dist + '/assets'));
}

// Copy page templates into finished HTML files
function pages() {
  return gulp
    .src('src/pages/**/*.{html,hbs,handlebars}')
    .pipe(
      panini({
        root: 'src/pages/',
        layouts: 'src/layouts/',
        partials: 'src/partials/',
        data: 'src/data/',
        helpers: 'src/helpers/',
      })
    )
    .pipe(gulp.dest(PATHS.dist));
}

// Load updated HTML templates and partials into Panini
function resetPages(done) {
  panini.refresh();
  done();
}

// Compile Sass into CSS
// In production, the CSS is compressed
function sass() {
  const postCssPlugins = [
    // Autoprefixer
    autoprefixer({ overrideBrowserslist: COMPATIBILITY }),

    // UnCSS - Uncomment to remove unused styles in production
    // PRODUCTION && uncss.postcssPlugin(UNCSS_OPTIONS),
  ].filter(Boolean);

  return gulp
    .src('src/assets/scss/style.scss')
    .pipe(sourcemaps.init())
    .pipe(
      pluginSass({
        includePaths: PATHS.sass,
      }).on('error', pluginSass.logError)
    )
    .pipe(postcss(postCssPlugins))
    .pipe(gulpIf(PRODUCTION, cleanCss({ compatibility: 'ie9' })))
    .pipe(sourcemaps.write())
    .pipe(gulp.dest(PATHS.dist + '/assets/css'))
    .pipe(browser.reload({ stream: true }));
}

// Combine JavaScript into one file
// In production, the file is minified
function javascript() {
  return gulp
    .src(PATHS.entries)
    .pipe(named())
    .pipe(sourcemaps.init())
    .pipe(
      webpackStream(
        {
          mode: PRODUCTION ? 'production' : 'development',
          module: {
            rules: [
              {
                test: /\.js$/,
                exclude: [/node_modules/],
                use: {
                  loader: 'babel-loader',
                  options: {
                    presets: ['@babel/preset-env'],
                    compact: false,
                  },
                },
              },
            ],
          },
          devtool: 'source-map',
        },
        webpack2
      )
    )
    .pipe(sourcemaps.write())
    .pipe(gulp.dest(PATHS.dist + '/assets/js'));
}

// Copy images to the "dist" folder
// In production, the images are compressed
function images_minify() {
  return gulp
    .src('src/assets/img/**/*')
    .pipe(gulpIf(PRODUCTION, imagemin([mozjpeg({ progressive: true })])))
    .pipe(gulp.dest(PATHS.dist + '/assets/img'));
}

function images_webp() {
  return gulp
    .src('src/assets/img/**/*')
    .pipe(gulpIf(!SKIP_COMPRESSION, webp()))
    .pipe(gulp.dest(PATHS.dist + '/assets/img'));
}

// Start a server with BrowserSync to preview the site in
function server(done) {
  browser.init(
    {
      // mirror server headers to dev env
      middleware: function (req, res, next) {
        let CSP = "default-src 'self' 'unsafe-inline' 'unsafe-eval' *.coronawarn.app; img-src 'self' *.coronawarn.app data:";

        res.setHeader('Content-Security-Policy', CSP);

        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('X-XSS-Protection', '1');

        next();
      },
      server: {
        baseDir: PATHS.dist,
        serveStaticOptions: {
          extensions: ['html'],
        },
      },
      port: PORT,
      open: !isCI(), // do not open webbrowser if running in CI
    },
    done
  );
}

// Reload the browser with BrowserSync
function reload(done) {
  browser.reload();
  done();
}

// Watch for changes to static assets, pages, Sass, and JavaScript
function watch(done) {
  if (isCI()) {
    console.log('Running in CI, skipping watch task.');
    done();
    return;
  }
  gulp.watch(PATHS.assets, copy);
  gulp
    .watch([
      'src/pages/**/*.html'
    ])
    .on('all', gulp.series(pages, reload));
  gulp.watch('src/{layouts,partials}/**/*.html').on('all', gulp.series(resetPages, pages, reload));
  gulp.watch('src/data/**/*.{js,json,yml}').on('all', gulp.series(resetPages, pages, reload));
  gulp.watch('src/helpers/**/*.js').on('all', gulp.series(resetPages, pages, reload));
  gulp.watch('src/assets/scss/**/*.scss').on('all', sass);
  gulp.watch('src/assets/js/**/*.js').on('all', gulp.series(javascript, reload));
  gulp.watch('src/assets/img/**/*').on('all', gulp.series(images_minify, images_webp, reload));
  done();
}

function AddEnglishSpecifier() {
  const data = JSON.parse(fs.readFileSync('src/data/english-texts.json', 'utf8'));
  return gulp
    .src([PATHS.dist + '/**/*.html'])
    .pipe(
      change(function () {
        // split HTML to exclude the <head>-section from replacement
        const splittedHtml = this.originalContent.split('</head>');
        const regex = new RegExp(`(?<!\w)(${data.texts.join('|')})(?![^<]*>)`, 'g');
        splittedHtml[1] = splittedHtml[1].replace(regex, (match) => {
          return `<span lang="en">${match}</span>`;
        });
        return splittedHtml.join('</head>');
      })
    )
    .pipe(gulp.dest(PATHS.dist));
}
