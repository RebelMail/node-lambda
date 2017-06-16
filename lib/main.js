'use strict'

const path = require('path')
const aws = require('aws-sdk')
const exec = require('child_process').exec
const execSync = require('child_process').execSync
const execFile = require('child_process').execFile
const fs = require('fs-extra')
const packageJson = require(path.join(__dirname, '..', 'package.json'))
const minimatch = require('minimatch')
const zip = new (require('node-zip'))()
const dotenv = require('dotenv')
const proxy = require('proxy-agent')
const ScheduleEvents = require(path.join(__dirname, 'schedule_events'))

const maxBufferSize = 50 * 1024 * 1024

const Lambda = function () {
  this.version = packageJson.version

  return this
}

Lambda.prototype._createSampleFile = function (file, boilerplateName) {
  var exampleFile = path.join(process.cwd(), file)
  var boilerplateFile = path.join(
    __dirname,
    (boilerplateName || file) + '.example'
  )

  if (!fs.existsSync(exampleFile)) {
    fs.writeFileSync(exampleFile, fs.readFileSync(boilerplateFile))
    console.log(exampleFile + ' file successfully created')
  }
}

Lambda.prototype.setup = function (program) {
  console.log('Running setup.')
  this._createSampleFile('.env', '.env')
  this._createSampleFile(program.eventFile, 'event.json')
  this._createSampleFile('deploy.env', 'deploy.env')
  this._createSampleFile(program.contextFile, 'context.json')
  this._createSampleFile('event_sources.json', 'event_sources.json')
  console.log('Setup done. Edit the .env, deploy.env, ' + program.contextFile + ' and ' + program.eventFile +
    ' files as needed.')
}

Lambda.prototype.run = function (program) {
  if (['nodejs4.3', 'nodejs6.10'].indexOf(program.runtime) === -1) {
    console.error(`Runtime [${program.runtime}] is not supported.`)
    process.exit(254)
  }

  this._createSampleFile(program.eventFile, 'event.json')
  const splitHandler = program.handler.split('.')
  const filename = splitHandler[0] + '.js'
  const handlername = splitHandler[1]

  // Set custom environment variables if program.configFile is defined
  if (program.configFile) {
    this._setRunTimeEnvironmentVars(program)
  }

  const handler = require(path.join(process.cwd(), filename))[handlername]
  const event = require(path.join(process.cwd(), program.eventFile))
  const context = require(path.join(process.cwd(), program.contextFile))

  if (!Array.isArray(event)) {
    return this._runHandler(handler, event, program, context)
  }
  this._runMultipleHandlers(event)
}

Lambda.prototype._runHandler = (handler, event, program, context) => {
  const startTime = new Date()
  const timeout = Math.min(program.timeout, 300) * 1000 // convert the timeout into milliseconds

  const callback = (err, result) => {
    if (err) {
      process.exitCode = 255
      console.log('Error: ' + err)
    } else {
      process.exitCode = 0
      console.log('Success:')
      if (result) {
        console.log(JSON.stringify(result))
      }
    }
    if (context.callbackWaitsForEmptyEventLoop === false) {
      process.exit()
    }
  }

  context.getRemainingTimeInMillis = () => {
    const currentTime = new Date()
    return timeout - (currentTime - startTime)
  }

  handler(event, context, callback)
}

Lambda.prototype._runMultipleHandlers = (events) => {
  console.log(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
Usually you will receive a single Object from AWS Lambda.
We added support for event.json to contain an array,
so you can easily test run multiple events.
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
`)

  const _argv = process.argv
  const eventFileOptionIndex = (() => {
    const index = _argv.indexOf('-j')
    if (index >= 0) return index
    return _argv.indexOf('--eventFile')
  })()
  _argv[0] = 'node' // For Windows support

  // In order to reproduce the logic of callbackWaitsForEmptyEventLoop,
  // we are going to execute `node-lambda run`.
  events.forEach((event, i) => {
    const tmpEventFile = `.${i}_tmp_event.json`
    const command = () => {
      if (eventFileOptionIndex === -1) {
        return _argv.concat(['-j', tmpEventFile]).join(' ')
      }
      _argv[eventFileOptionIndex + 1] = tmpEventFile
      return _argv.join(' ')
    }

    fs.writeFileSync(tmpEventFile, JSON.stringify(event))
    const stdout = execSync(command(), {
      maxBuffer: maxBufferSize,
      env: process.env
    })
    console.log('>>> Event:', event, '<<<')
    console.log(stdout.toString())
    fs.unlinkSync(tmpEventFile)
  })
}

Lambda.prototype._params = function (program, buffer) {
  var params = {
    FunctionName: program.functionName +
      (program.environment ? '-' + program.environment : '') +
      (program.lambdaVersion ? '-' + program.lambdaVersion : ''),
    Code: {
      ZipFile: buffer
    },
    Handler: program.handler,
    Role: program.role,
    Runtime: program.runtime,
    Description: program.description,
    MemorySize: program.memorySize,
    Timeout: program.timeout,
    Publish: program.publish,
    VpcConfig: {
      SubnetIds: [],
      SecurityGroupIds: []
    },
    Environment: {
      Variables: null
    },
    DeadLetterConfig: {
      TargetArn: null
    },
    TracingConfig: {
      Mode: null
    }
  }

  // Escape characters that is not allowed by AWS Lambda
  params.FunctionName = params.FunctionName.replace(/[^a-zA-Z0-9-_]/g, '_')

  if (program.vpcSubnets && program.vpcSecurityGroups) {
    params.VpcConfig = {
      'SubnetIds': program.vpcSubnets.split(','),
      'SecurityGroupIds': program.vpcSecurityGroups.split(',')
    }
  }
  if (program.configFile) {
    var configValues = fs.readFileSync(program.configFile)
    var config = dotenv.parse(configValues)
    // If `configFile` is an empty file, `config` value will be `{}`
    params.Environment = {
      Variables: config
    }
  }
  if (program.deadLetterConfigTargetArn !== undefined) {
    params.DeadLetterConfig = {
      TargetArn: program.deadLetterConfigTargetArn
    }
  }
  if (program.tracingConfig) {
    params.TracingConfig.Mode = program.tracingConfig
  }

  return params
}

Lambda.prototype._eventSourceList = function (program) {
  if (!program.eventSourceFile) {
    return {
      EventSourceMappings: null,
      ScheduleEvents: null
    }
  }
  const list = (function () {
    try {
      return fs.readJsonSync(program.eventSourceFile)
    } catch (err) {
      throw err
    }
  })()

  if (Array.isArray(list)) {
    // backward-compatible
    return {
      EventSourceMappings: list,
      ScheduleEvents: []
    }
  }
  if (!list.EventSourceMappings) {
    list.EventSourceMappings = []
  }
  if (!list.ScheduleEvents) {
    list.ScheduleEvents = []
  }
  return list
}

Lambda.prototype._fileCopy = function (program, src, dest, excludeNodeModules, callback) {
  const srcAbsolutePath = path.resolve(src)
  const excludes = (function () {
    return [
      '.git*',
      '*.swp',
      '.editorconfig',
      '.lambda',
      'deploy.env',
      '*.log',
      path.join(path.sep, 'build', path.sep)
    ]
    .concat(program.excludeGlobs ? program.excludeGlobs.split(' ') : [])
    .concat(excludeNodeModules ? [path.join(path.sep, 'node_modules')] : [])
  })()

  // Formatting for `filter` of `fs.copy`
  const dirBlobs = []
  const pattern = '{' + excludes.map(function (str) {
    if (str.charAt(str.length - 1) === path.sep) {
      str = str.substr(0, str.length - 1)
      dirBlobs.push(str)
    }
    if (str.charAt(0) === path.sep) {
      return path.join(srcAbsolutePath, str)
    }
    if (str.indexOf(path.sep) >= 0) {
      return path.join(path.resolve('/**'), str)
    }
    return str
  }).join(',') + '}'
  const dirPatternRegExp = new RegExp(`(${dirBlobs.join('|')})$`)

  fs.mkdirs(dest, function (err) {
    if (err) {
      return callback(err)
    }
    const options = {
      dereference: true, // same meaning as `-L` of `rsync` command
      filter: function (src, dest) {
        if (!program.prebuiltDirectory && src === path.join(srcAbsolutePath, 'package.json')) {
          // include package.json unless prebuiltDirectory is set
          return true
        }

        if (!minimatch(src, pattern, { matchBase: true })) {
          return true
        }
        // Directory check. Even if `src` is a directory it will not end with '/'.
        if (!dirPatternRegExp.test(src)) {
          return false
        }
        return !fs.statSync(src).isDirectory()
      }
    }
    fs.copy(src, dest, options, function (err) {
      if (err) {
        return callback(err)
      }

      return callback(null, true)
    })
  })
}

// `_rsync` will be replaced by` _fileCopy`.
Lambda.prototype._rsync = function (program, src, dest, excludeNodeModules, callback) {
  var excludes = ['.git*', '*.swp', '.editorconfig', '.lambda', 'deploy.env', '*.log', '/build/']
  var excludeGlobs = []
  if (program.excludeGlobs) {
    excludeGlobs = program.excludeGlobs.split(' ')
  }
  var excludeArgs = excludeGlobs
    .concat(excludes)
    .concat(excludeNodeModules ? ['/node_modules'] : [])
    .map(function (exclude) {
      return '--exclude=' + exclude
    }).join(' ')

  fs.mkdirs(dest, function (err) {
    if (err) {
      return callback(err)
    }

    // include package.json unless prebuiltDirectory is set
    var includeArgs = program.prebuiltDirectory ? '' : '--include /package.json '

    // we need the extra / after src to make sure we are copying the content
    // of the directory, not the directory itself.
    exec('rsync -rL ' + includeArgs + excludeArgs + ' ' + src.trim() + '/ ' + dest, {
      maxBuffer: maxBufferSize,
      env: process.env
    }, function (err) {
      if (err) {
        return callback(err)
      }

      return callback(null, true)
    })
  })
}

Lambda.prototype._npmInstall = (program, codeDirectory, callback) => {
  const dockerBaseOptions = [
    'run', '--rm', '-v', `${codeDirectory}:/var/task`,
    program.dockerImage,
    'npm', '-s', 'install', '--production'
  ]
  const npmInstallBaseOptions = [
    '-s',
    'install',
    '--production',
    '--prefix', codeDirectory
  ]

  const params = (() => {
    // reference: https://nodejs.org/api/child_process.html#child_process_spawning_bat_and_cmd_files_on_windows

    // with docker
    if (program.dockerImage) {
      if (process.platform === 'win32') {
        return {
          command: 'cmd.exe',
          options: ['/c', 'docker'].concat(dockerBaseOptions)
        }
      }
      return {
        command: 'docker',
        options: dockerBaseOptions
      }
    }

    // simple npm install
    if (process.platform === 'win32') {
      return {
        command: 'cmd.exe',
        options: ['/c', 'npm']
          .concat(npmInstallBaseOptions)
          .concat(['--cwd', codeDirectory])
      }
    }
    return {
      command: 'npm',
      options: npmInstallBaseOptions
    }
  })()

  execFile(params.command, params.options, {
    maxBuffer: maxBufferSize,
    env: process.env
  }, (err) => {
    if (err) {
      return callback(err)
    }

    return callback(null, true)
  })
}

Lambda.prototype._postInstallScript = function (program, codeDirectory, callback) {
  var scriptFilename = 'post_install.sh'
  var cmd = path.join(codeDirectory, scriptFilename) + ' ' + program.environment

  var filePath = path.join(codeDirectory, scriptFilename)

  if (!fs.existsSync(filePath)) {
    return callback(null)
  }
  console.log('=> Running post install script ' + scriptFilename)
  exec(cmd, {
    env: process.env,
    cwd: codeDirectory,
    maxBuffer: maxBufferSize
  }, function (error, stdout, stderr) {
    if (error) {
      return callback(new Error(`${error} stdout: ${stdout} stderr: ${stderr}`))
    }
    console.log('\t\t' + stdout)
    callback(null)
  })
}

Lambda.prototype._zip = function (program, codeDirectory, callback) {
  var options = {
    type: 'nodebuffer',
    compression: 'DEFLATE'
  }

  console.log('=> Zipping repo. This might take up to 30 seconds')
  fs.walk(codeDirectory)
    .on('data', function (file) {
      if (!file.stats.isDirectory()) {
        var content = fs.readFileSync(file.path)
        var filePath = file.path.replace(path.join(codeDirectory, path.sep), '')
        zip.file(filePath, content)
      }
    })
    .on('end', function () {
      var data = zip.generate(options)
      return callback(null, data)
    })
}

Lambda.prototype._codeDirectory = function () {
  return path.resolve('.', '.lambda')
}

Lambda.prototype._cleanDirectory = function (codeDirectory, callback) {
  fs.remove(codeDirectory, function (err) {
    if (err) {
      throw err
    }

    fs.mkdirs(codeDirectory, function (err) {
      if (err) {
        throw err
      }

      return callback(null, true)
    })
  })
}

Lambda.prototype._setRunTimeEnvironmentVars = function (program) {
  var configValues = fs.readFileSync(program.configFile)
  var config = dotenv.parse(configValues)

  for (let k in config) {
    if (!config.hasOwnProperty(k)) {
      continue
    }

    process.env[k] = config[k]
  }
}

Lambda.prototype._uploadExisting = (lambda, params) => {
  return new Promise((resolve, reject) => {
    const request = lambda.updateFunctionCode({
      'FunctionName': params.FunctionName,
      'ZipFile': params.Code.ZipFile,
      'Publish': params.Publish
    }, (err) => {
      if (err) return reject(err)

      lambda.updateFunctionConfiguration({
        'FunctionName': params.FunctionName,
        'Description': params.Description,
        'Handler': params.Handler,
        'MemorySize': params.MemorySize,
        'Role': params.Role,
        'Timeout': params.Timeout,
        'Runtime': params.Runtime,
        'VpcConfig': params.VpcConfig,
        'Environment': params.Environment,
        'DeadLetterConfig': params.DeadLetterConfig,
        'TracingConfig': params.TracingConfig
      }, (err, data) => {
        if (err) return reject(err)
        resolve(data)
      })
    })

    request.on('retry', (response) => {
      console.log(response.error.message)
      console.log('=> Retrying')
    })
  })
}

Lambda.prototype._uploadNew = (lambda, params) => {
  return new Promise((resolve, reject) => {
    const request = lambda.createFunction(params, (err, data) => {
      if (err) return reject(err)
      resolve(data)
    })
    request.on('retry', (response) => {
      console.log(response.error.message)
      console.log('=> Retrying')
    })
  })
}

Lambda.prototype._readArchive = function (program, archiveCallback) {
  if (!fs.existsSync(program.deployZipfile)) {
    var err = new Error('No such Zipfile [' + program.deployZipfile + ']')
    return archiveCallback(err)
  }
  fs.readFile(program.deployZipfile, archiveCallback)
}

Lambda.prototype._archive = function (program, archiveCallback) {
  if (program.deployZipfile && fs.existsSync(program.deployZipfile)) {
    return this._readArchive(program, archiveCallback)
  }
  return program.prebuiltDirectory
    ? this._archivePrebuilt(program, archiveCallback)
    : this._buildAndArchive(program, archiveCallback)
}

Lambda.prototype._archivePrebuilt = function (program, archiveCallback) {
  var codeDirectory = this._codeDirectory()
  var _this = this

  // It is switched to `_ rsync` by environment variable.
  // (Used if there is a problem with `_ fileCopy`)
  // If there is no problem even if deleting `_rsync`, this switching process is deleted
  var copyFunction = '_fileCopy'
  if (process.env.NODE_LAMBDA_COPY_FUNCTION === 'rsync') {
    console.log('=> INFO: Use rsync for copy')
    copyFunction = '_rsync'
  }
  this[copyFunction](program, program.prebuiltDirectory, codeDirectory, false, function (err) {
    if (err) {
      return archiveCallback(err)
    }

    console.log('=> Zipping deployment package')
    _this._zip(program, codeDirectory, archiveCallback)
  })
}

Lambda.prototype._buildAndArchive = function (program, archiveCallback) {
  if (!fs.existsSync('.env')) {
    console.warn('[Warning] `.env` file does not exist.')
    console.info('Execute `node-lambda setup` as necessary and set it up.')
  }

  // Warn if not building on 64-bit linux
  var arch = process.platform + '.' + process.arch
  if (arch !== 'linux.x64' && !program.dockerImage) {
    console.warn('Warning!!! You are building on a platform that is not 64-bit Linux (%s). ' +
      'If any of your Node dependencies include C-extensions, they may not work as expected in the ' +
      'Lambda environment.\n\n', arch)
  }

  var _this = this
  var codeDirectory = _this._codeDirectory()
  var lambdaSrcDirectory = program.sourceDirectory ? program.sourceDirectory.replace(/\/$/, '') : '.'

  _this._cleanDirectory(codeDirectory, function (err) {
    if (err) {
      return archiveCallback(err)
    }
    console.log('=> Moving files to temporary directory')

    // It is switched to `_ rsync` by environment variable.
    // (Used if there is a problem with `_ fileCopy`)
    // If there is no problem even if deleting `_rsync`, this switching process is deleted
    var copyFunction = '_fileCopy'
    if (process.env.NODE_LAMBDA_COPY_FUNCTION === 'rsync') {
      console.log('=> INFO: Use rsync for copy')
      copyFunction = '_rsync'
    }
    // Move files to tmp folder
    _this[copyFunction](program, lambdaSrcDirectory, codeDirectory, true, function (err) {
      if (err) {
        return archiveCallback(err)
      }
      console.log('=> Running npm install --production')
      _this._npmInstall(program, codeDirectory, function (err) {
        if (err) {
          return archiveCallback(err)
        }

        _this._postInstallScript(program, codeDirectory, function (err) {
          if (err) {
            return archiveCallback(err)
          }

          console.log('=> Zipping deployment package')
          _this._zip(program, codeDirectory, archiveCallback)
        })
      })
    })
  })
}

Lambda.prototype._listEventSourceMappings = function (lambda, params, cb) {
  return lambda.listEventSourceMappings(params, function (err, data) {
    var eventSourceMappings = []
    if (!err && data && data.EventSourceMappings) {
      eventSourceMappings = data.EventSourceMappings
    }
    return cb(err, eventSourceMappings)
  })
}

Lambda.prototype._updateEventSources = (lambda, functionName, existingEventSourceList, eventSourceList) => {
  if (eventSourceList == null) {
    return Promise.resolve([])
  }
  const updateEventSourceList = []
  // Checking new and update event sources
  for (let i in eventSourceList) {
    let isExisting = false
    for (let j in existingEventSourceList) {
      if (eventSourceList[i]['EventSourceArn'] === existingEventSourceList[j]['EventSourceArn']) {
        isExisting = true
        updateEventSourceList.push({
          'type': 'update',
          'FunctionName': functionName,
          'Enabled': eventSourceList[i]['Enabled'],
          'BatchSize': eventSourceList[i]['BatchSize'],
          'UUID': existingEventSourceList[j]['UUID']
        })
        break
      }
    }

    // If it is new source
    if (!isExisting) {
      updateEventSourceList.push({
        'type': 'create',
        'FunctionName': functionName,
        'EventSourceArn': eventSourceList[i]['EventSourceArn'],
        'Enabled': eventSourceList[i]['Enabled'] ? eventSourceList[i]['Enabled'] : false,
        'BatchSize': eventSourceList[i]['BatchSize'] ? eventSourceList[i]['BatchSize'] : 100,
        'StartingPosition': eventSourceList[i]['StartingPosition'] ? eventSourceList[i]['StartingPosition'] : 'LATEST'
      })
    }
  }

  // Checking delete event sources
  for (let i in existingEventSourceList) {
    let isExisting = false
    for (let j in eventSourceList) {
      if (eventSourceList[j]['EventSourceArn'] === existingEventSourceList[i]['EventSourceArn']) {
        isExisting = true
        break
      }
    }

    // If delete the source
    if (!isExisting) {
      updateEventSourceList.push({
        'type': 'delete',
        'UUID': existingEventSourceList[i]['UUID']
      })
    }
  }

  return Promise.all(updateEventSourceList.map((updateEventSource) => {
    switch (updateEventSource['type']) {
      case 'create':
        delete updateEventSource['type']
        return new Promise((resolve, reject) => {
          lambda.createEventSourceMapping(updateEventSource, (err, data) => {
            if (err) return reject(err)
            resolve(data)
          })
        })
      case 'update':
        delete updateEventSource['type']
        return new Promise((resolve, reject) => {
          lambda.updateEventSourceMapping(updateEventSource, (err, data) => {
            if (err) return reject(err)
            resolve(data)
          })
        })
      case 'delete':
        delete updateEventSource['type']
        return new Promise((resolve, reject) => {
          lambda.deleteEventSourceMapping(updateEventSource, (err, data) => {
            if (err) return reject(err)
            resolve(data)
          })
        })
    }
    return Promise.resolve()
  })).then((data) => {
    return Promise.resolve(data)
  }).catch((err) => {
    return Promise.reject(err)
  })
}

Lambda.prototype._updateScheduleEvents = (scheduleEvents, functionArn, scheduleList) => {
  if (scheduleList == null) {
    return Promise.resolve([])
  }

  const paramsList = scheduleList.map((schedule) =>
    Object.assign(schedule, { FunctionArn: functionArn }))

  // series
  return paramsList.map((params) => {
    return scheduleEvents.add(params)
  }).reduce((a, b) => {
    return a.then(b)
  }, Promise.resolve()).then(() => {
    // Since `scheduleEvents.add(params)` returns only `{}` if it succeeds
    // it is not very meaningful.
    // Therefore, return the params used for execution
    return Promise.resolve(paramsList)
  }).catch((err) => {
    return Promise.reject(err)
  })
}

Lambda.prototype.package = function (program) {
  var _this = this
  if (!program.packageDirectory) {
    throw new Error('packageDirectory not specified!')
  }
  try {
    var isDir = fs.lstatSync(program.packageDirectory).isDirectory()

    if (!isDir) {
      throw new Error(program.packageDirectory + ' is not a directory!')
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('=> Creating package directory')
      fs.mkdirsSync(program.packageDirectory)
    } else {
      throw err
    }
  }

  _this._archive(program, function (err, buffer) {
    if (err) {
      throw err
    }

    var basename = program.functionName + (program.environment ? '-' + program.environment : '')
    var zipfile = path.join(program.packageDirectory, basename + '.zip')
    console.log('=> Writing packaged zip')
    fs.writeFile(zipfile, buffer, function (err) {
      if (err) {
        throw err
      }
      console.log('Packaged zip created: ' + zipfile)
    })
  })
}

Lambda.prototype._deployToRegion = function (program, params, region) {
  const _this = this
  console.log('=> Reading event source file to memory')
  const eventSourceList = _this._eventSourceList(program)

  return new Promise((resolve, reject) => {
    console.log('=> Uploading zip file to AWS Lambda ' + region + ' with parameters:')
    console.log(params)

    const awsSecurity = { region: region }

    if (program.profile) {
      aws.config.credentials = new aws.SharedIniFileCredentials({
        profile: program.profile
      })
    } else {
      awsSecurity.accessKeyId = program.accessKey
      awsSecurity.secretAccessKey = program.secretKey
    }

    if (program.sessionToken) {
      awsSecurity.sessionToken = program.sessionToken
    }

    if (program.deployTimeout) {
      aws.config.httpOptions.timeout = parseInt(program.deployTimeout)
    }

    if (program.proxy) {
      aws.config.httpOptions.agent = proxy(program.proxy)
    }

    aws.config.update(awsSecurity)

    const lambda = new aws.Lambda({ apiVersion: '2015-03-31' })
    const scheduleEvents = new ScheduleEvents(aws)

    // Checking function
    return lambda.getFunction({
      'FunctionName': params.FunctionName
    }, (err) => {
      if (err) {
        // Function does not exist
        return _this._uploadNew(lambda, params).then((results) => {
          console.log('=> Zip file(s) done uploading. Results follow: ')
          console.log(results)

          return Promise.all([
            _this._updateEventSources(
              lambda,
              params.FunctionName,
              [],
              eventSourceList.EventSourceMappings
            ),
            _this._updateScheduleEvents(
              scheduleEvents,
              results.FunctionArn,
              eventSourceList.ScheduleEvents
            )
          ]).then((results) => {
            resolve(results)
          }).catch((err) => {
            reject(err)
          })
        }).catch((err) => {
          reject(err)
        })
      }

      // Function exists
      _this._listEventSourceMappings(lambda, {
        'FunctionName': params.FunctionName
      }, (err, existingEventSourceList) => {
        if (err) return reject(err)

        return Promise.all([
          _this._uploadExisting(lambda, params).then((results) => {
            console.log('=> Zip file(s) done uploading. Results follow: ')
            console.log(results)
            return _this._updateScheduleEvents(
              scheduleEvents,
              results.FunctionArn,
              eventSourceList.ScheduleEvents
            )
          }),
          _this._updateEventSources(
            lambda,
            params.FunctionName,
            existingEventSourceList,
            eventSourceList.EventSourceMappings
          )
        ]).then((results) => {
          resolve(results)
        }).catch((err) => {
          reject(err)
        })
      })
    })
  })
}

Lambda.prototype.deploy = function (program) {
  const _this = this
  const regions = program.region.split(',')
  _this._archive(program, (err, buffer) => {
    if (err) throw err

    console.log('=> Reading zip file to memory')
    const params = _this._params(program, buffer)

    Promise.all(regions.map((region) => {
      return _this._deployToRegion(program, params, region)
    })).then((results) => {
      const resultsIsEmpty = results.filter((result) => {
        return result.filter((res) => {
          return res.length > 0
        }).length > 0
      }).length === 0
      if (!resultsIsEmpty) {
        console.log('=> All tasks done. Results follow: ')
        console.log(JSON.stringify(results, null, ' '))
      }
    }).catch((err) => {
      console.log(err)
    })
  })
}

module.exports = new Lambda()
