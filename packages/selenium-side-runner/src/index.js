#!/usr/bin/env node

// Licensed to the Software Freedom Conservancy (SFC) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The SFC licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fork } from 'child_process'
import program from 'commander'
import winston from 'winston'
import glob from 'glob'
import rimraf from 'rimraf'
import { js_beautify as beautify } from 'js-beautify'
import Selianize from 'selianize'
import Capabilities from './capabilities'
import Config from './config'
import Satisfies from './versioner'
import metadata from '../package.json'
import uuidV4 from 'uuid/v4'

const DEFAULT_TIMEOUT = 15000

process.title = metadata.name

program
  .usage('[options] project.side [project.side] [*.side]')
  .version(metadata.version)
  .option('-c, --capabilities [list]', 'Webdriver capabilities')
  .option('-s, --server [url]', 'Webdriver remote server')
  .option('-p, --params [list]', 'General parameters')
  .option('-f, --filter [string]', 'Run suites matching name')
  .option('-t, --accesstoken [string]', 'Salesforce accessToken')
  .option(
    '-w, --max-workers [number]',
    'Maximum amount of workers that will run your tests, defaults to number of cores'
  )
  .option('--base-url [url]', 'Override the base URL that was set in the IDE')
  .option(
    '--timeout [number | undefined]',
    `The maximimum amount of time, in milliseconds, to spend attempting to locate an element. (default: ${DEFAULT_TIMEOUT})`
  )
  .option(
    '--configuration-file [filepath]',
    'Use specified YAML file for configuration. (default: .side.yml)'
  )
  .option(
    '--output-directory [directory]',
    'Write test results to files, results written in JSON'
  )
  .option('--debug', 'Print debug logs')

if (process.env.NODE_ENV === 'development') {
  program.option(
    '-e, --extract',
    'Only extract the project file to code (this feature is for debugging purposes)'
  )
  program.option(
    '-r, --run [directory]',
    'Run the extracted project files (this feature is for debugging purposes)'
  )
}

program.parse(process.argv)

if (!program.args.length && !program.run) {
  program.outputHelp()
  process.exit(1)
}

const logger = winston.createLogger(
  {
    level: 'info',
    format: winston.format.cli(),
    transports: [
      new winston.transports.Console(),
      //new winston.transports.File({ filename: 'logfile.log' })
    ],
  },
  {
    level: 'warn',
    format: winston.format.cli(),
    transports: [
      new winston.transports.Console(),
      //new winston.transports.File({ filename: 'logfile.log' })
    ],
  },
  {
    level: 'debug',
    format: winston.format.cli(),
    transports: [
      new winston.transports.Console(),
      //new winston.transports.File({ filename: 'logfile.log' })
    ],
  }
)
logger.level = program.debug ? 'debug' : 'info'

if (program.extract || program.run) {
  logger.warn(
    "This feature is used by Selenium IDE maintainers for debugging purposes, we hope you know what you're doing!"
  )
}

const configuration = {
  capabilities: {
    browserName: 'chrome',
  },
  params: {},
  runId: crypto.randomBytes(16).toString('hex'),
  path: path.join(__dirname, '../../'),
}

const configurationFilePath = program.configurationFile || '.side.yml'
try {
  Object.assign(
    configuration,
    Config.load(path.join(process.cwd(), configurationFilePath))
  )
} catch (e) {
  logger.debug('Could not load ' + configurationFilePath)
}

program.filter = program.filter || '*'
configuration.server = program.server ? program.server : configuration.server

configuration.timeout = program.timeout
  ? +program.timeout
  : configuration.timeout
    ? +configuration.timeout
    : DEFAULT_TIMEOUT // eslint-disable-line indent

if (configuration.timeout === 'undefined') configuration.timeout = undefined

if (program.capabilities) {
  try {
    Object.assign(
      configuration.capabilities,
      Capabilities.parseString(program.capabilities)
    )
  } catch (e) {
    logger.debug('Failed to parse inline capabilities')
  }
}

if (program.params) {
  try {
    Object.assign(
      configuration.params,
      Capabilities.parseString(program.params)
    )
  } catch (e) {
    logger.debug('Failed to parse additional params')
  }
}

configuration.baseUrl = program.baseUrl
  ? program.baseUrl
  : configuration.baseUrl

let projectPath

function runProject(project) {
  logger.info(`Running ${project.path}`)
  let warning
  try {
    warning = Satisfies(project.version, '1.1')
  } catch (e) {
    return Promise.reject(e)
  }
  if (warning) {
    logger.warn(warning)
  }
  if (!project.suites.length) {
    return Promise.reject(
      new Error(
        `The project ${
          project.name
        } has no test suites defined, create a suite using the IDE.`
      )
    )
  }
  projectPath = `side-suite-${project.name}`
  rimraf.sync(projectPath)
  fs.mkdirSync(projectPath)
  fs.writeFileSync(
    path.join(projectPath, 'package.json'),
    JSON.stringify({
      name: project.name,
      version: '0.0.0',
      jest: {
        modulePaths: [path.join(__dirname, '../node_modules')],
        setupTestFrameworkScriptFile: require.resolve(
          'jest-environment-selenium/dist/setup.js'
        ),
        testEnvironment: 'jest-environment-selenium',
        testEnvironmentOptions: configuration,
      },
      dependencies: project.dependencies || {},
    })
  )

  return Selianize(
    project,
    {
      silenceErrors: true,
    },
    project.snapshot
  ).then(code => {
    const tests = code.tests
      .reduce((tests, test) => {
        return (tests += test.code)
      }, 'const tests = {};')
      .concat('module.exports = tests;')
    writeJSFile(path.join(projectPath, 'commons'), tests, '.js')
    code.suites.forEach(suite => {
      if (!suite.tests) {
        // not parallel
        const cleanup = suite.persistSession
          ? ''
          : 'beforeEach(() => {vars = {};});afterEach(async () => (cleanup()));'
        writeJSFile(
          path.join(projectPath, suite.name),
          `// This file was generated using Selenium IDE\nconst tests = require("./commons.js");${
            code.globalConfig
          }${suite.code}${cleanup}`
        )
      } else if (suite.tests.length) {
        fs.mkdirSync(path.join(projectPath, suite.name))
        // parallel suite
        suite.tests.forEach(test => {
          writeJSFile(
            path.join(projectPath, suite.name, test.name),
            `// This file was generated using Selenium IDE\nconst tests = require("../commons.js");${
              code.globalConfig
            }${test.code}`
          )
        })
      }
    })

    return new Promise((resolve, reject) => {
      let npmInstall
      if (project.dependencies && Object.keys(project.dependencies).length) {
        npmInstall = new Promise((resolve, reject) => {
          const child = fork(require.resolve('./npm'), {
            cwd: path.join(process.cwd(), projectPath),
            stdio: 'inherit',
          })
          child.on('exit', code => {
            if (code) {
              reject()
            } else {
              resolve()
            }
          })
        })
      } else {
        npmInstall = Promise.resolve()
      }
      npmInstall
        .then(() => {
          if (program.extract) {
            resolve()
          } else {
            runJest(project)
              .then(resolve)
              .catch(reject)
          }
        })
        .catch(reject)
    })
  })
}

function runJest(project) {
  return new Promise((resolve, reject) => {
    const args = [
      '--testMatch',
      `{**/*${program.filter}*/*.test.js,**/*${program.filter}*.test.js}`,
    ]
      .concat(program.maxWorkers ? ['-w', program.maxWorkers] : [])
      .concat(
        program.outputDirectory
          ? [
              '--json',
              '--outputFile',
              path.isAbsolute(program.outputDirectory)
                ? path.join(program.outputDirectory, `${project.name}.json`)
                : path.join(
                    '..',
                    program.outputDirectory,
                    `${project.name}.json`
                  ),
            ]
          : []
      )
    //fs.closeSync(fs.openSync(path.join(process.cwd(), program.outputDirectory, `${project.name}.json`), 'w'));
    const opts = {
      cwd: path.join(process.cwd(), projectPath),
      stdio: 'inherit',
    }
    logger.debug('jest worker args')
    logger.debug(args)
    logger.debug('jest work opts')
    logger.debug(JSON.stringify(opts))
    const child = fork(require.resolve('./child'), args, opts)

    child.on('exit', code => {
      // eslint-disable-next-line no-console
      console.log('')
      if (!program.run) {
        rimraf.sync(projectPath)
      }
      if (code) {
        reject()
      } else {
        resolve()
      }
    })
  })
}

function runAll(projects, index = 0) {
  if (index >= projects.length) return Promise.resolve()
  return runProject(projects[index])
    .then(() => {
      return runAll(projects, ++index)
    })
    .catch(error => {
      process.exitCode = 1
      error && logger.error(error.message + '\n')
      return runAll(projects, ++index)
    })
}

function writeJSFile(name, data, postfix = '.test.js') {
  fs.writeFileSync(
    `${name}${postfix}`,
    beautify(data, {
      indent_size: 2,
    })
  )
}

const projects = [
  ...program.args.reduce((projects, project) => {
    glob.sync(project).forEach(p => {
      projects.add(p)
    })
    return projects
  }, new Set()),
].map(p => {
  const project = JSON.parse(fs.readFileSync(p))
  project.path = p
  if (program.accesstoken) {
    project.tests.forEach(t => {
      t.commands.unshift({
        id: uuidV4(),
        comment: '',
        command: 'open',
        target: `/secur/frontdoor.jsp?sid=${program.accesstoken}`,
        targets: [],
        value: '',
      })
    })
  }
  if (logger.level == 'debug') {
    project.tests.forEach(t => {
      let new_commands = []
      for (let i in t.commands) {
        new_commands.push(t.commands[i])
        if (t.commands[i].value != '') {
          if (t.commands[i].command == 'type') {
            new_commands.push({
              id: uuidV4(),
              comment: '',
              command: 'echo',
              target: `type: ${t.commands[i].value}`,
              targets: [],
              value: '',
            })
          } else {
            new_commands.push({
              id: uuidV4(),
              comment: '',
              command: 'echo',
              target: `${t.commands[i].value}: \${${t.commands[i].value}}`,
              targets: [],
              value: '',
            })
          }
        }
      }
      t.commands = new_commands
    })
  }
  return project
})

function handleQuit(_signal, code) {
  if (!program.run) {
    rimraf.sync(projectPath)
  }
  process.exit(code)
}

process.on('SIGINT', handleQuit)
process.on('SIGTERM', handleQuit)

if (program.run) {
  projectPath = program.run
  runJest({
    name: 'test',
  }).catch(logger.error)
} else {
  runAll(projects)
}
