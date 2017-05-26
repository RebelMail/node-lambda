'use strict'

const assert = require('chai').assert
const path = require('path')
const fs = require('fs-extra')
const spawn = require('child_process').spawn
const execSync = require('child_process').execSync
const nodeLambdaPath = path.join(__dirname, '..', 'bin', 'node-lambda')

/* global before, after, describe, it */
// The reason for specifying the node command in this test is to support Windows.
describe('bin/node-lambda', () => {
  describe('node-lambda run', () => {
    const _testMain = (expectedValues, done) => {
      const run = spawn('node', [
        nodeLambdaPath, 'run',
        '--handler', '__test.handler',
        '--eventFile', 'event.json'
      ])
      var stdoutString = ''
      run.stdout.on('data', (data) => {
        stdoutString += data.toString().replace(/\r|\n/g, '')
      })

      run.on('exit', (code) => {
        assert.match(stdoutString, expectedValues.stdoutRegExp)
        assert.equal(code, expectedValues.exitCode)
        done()
      })
    }

    const _generateEventFile = (eventObj) => {
      fs.writeFileSync('event.json', JSON.stringify(eventObj))
    }

    before(() => {
      execSync(`node ${nodeLambdaPath} setup`)
      fs.copy(path.join(__dirname, 'handler', 'index.js'), '__test.js')
    })

    after(() => {
      [
        '.env',
        'context.json',
        'event.json',
        'deploy.env',
        'event_sources.json',
        '__test.js'
      ].forEach((file) => fs.unlinkSync(file))
    })

    describe('node-lambda run (Handler only sync processing)', () => {
      const eventObj = {
        asyncTest: false,
        callbackWaitsForEmptyEventLoop: true // True is the default value of Lambda
      }

      it('`node-lambda run` exitCode is `0` (callback(null))', (done) => {
        _generateEventFile(Object.assign(eventObj, {
          callbackCode: 'callback(null);'
        }))
        _testMain({ stdoutRegExp: /Success:$/, exitCode: 0 }, done)
      })

      it('`node-lambda run` exitCode is `0` (callback(null, "text"))', (done) => {
        _generateEventFile(Object.assign(eventObj, {
          callbackCode: 'callback(null, "text");'
        }))
        _testMain({ stdoutRegExp: /Success:"text"$/, exitCode: 0 }, done)
      })

      it('`node-lambda run` exitCode is `255` (callback(new Error("e")))', (done) => {
        _generateEventFile(Object.assign(eventObj, {
          callbackCode: 'callback(new Error("e"));'
        }))
        _testMain({ stdoutRegExp: /Error: Error: e$/, exitCode: 255 }, done)
      })
    })

    describe('node-lambda run (Handler includes async processing)', () => {
      describe('callbackWaitsForEmptyEventLoop = true', function () {
        this.timeout(5000) // give it time to setTimeout

        const eventObj = {
          asyncTest: true,
          callbackWaitsForEmptyEventLoop: true
        }

        it('`node-lambda run` exitCode is `0` (callback(null))', (done) => {
          _generateEventFile(Object.assign(eventObj, {
            callbackCode: 'callback(null);'
          }))
          _testMain({ stdoutRegExp: /Success:sleep 3500 msec$/, exitCode: 0 }, done)
        })

        it('`node-lambda run` exitCode is `0` (callback(null, "text"))', (done) => {
          _generateEventFile(Object.assign(eventObj, {
            callbackCode: 'callback(null, "text");'
          }))
          _testMain({ stdoutRegExp: /Success:"text"sleep 3500 msec$/, exitCode: 0 }, done)
        })

        it('`node-lambda run` exitCode is `255` (callback(new Error("e")))', (done) => {
          _generateEventFile(Object.assign(eventObj, {
            callbackCode: 'callback(new Error("e"));'
          }))
          _testMain({ stdoutRegExp: /Error: Error: esleep 3500 msec$/, exitCode: 255 }, done)
        })
      })

      describe('callbackWaitsForEmptyEventLoop = false', () => {
        const eventObj = {
          asyncTest: true,
          callbackWaitsForEmptyEventLoop: false
        }

        it('`node-lambda run` exitCode is `0` (callback(null))', (done) => {
          _generateEventFile(Object.assign(eventObj, {
            callbackCode: 'callback(null);'
          }))
          _testMain({ stdoutRegExp: /Success:$/, exitCode: 0 }, done)
        })

        it('`node-lambda run` exitCode is `0` (callback(null, "text"))', (done) => {
          _generateEventFile(Object.assign(eventObj, {
            callbackCode: 'callback(null, "text");'
          }))
          _testMain({ stdoutRegExp: /Success:"text"$/, exitCode: 0 }, done)
        })

        it('`node-lambda run` exitCode is `255` (callback(new Error("e")))', (done) => {
          _generateEventFile(Object.assign(eventObj, {
            callbackCode: 'callback(new Error("e"));'
          }))
          _testMain({ stdoutRegExp: /Error: Error: e$/, exitCode: 255 }, done)
        })
      })
    })
  })
})
