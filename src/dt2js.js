'use strict'

var yap = require('yaml-ast-parser')
var dtexp = require('datatype-expansion')
var constants = require('./constants')
var utils = require('./utils')
var fs = require('fs')
var path = require('path')
var request = require('sync-request')
var deep = require('deep-get-set')
deep.p = true

var basePath = process.cwd()
/**
 * Get RAML Data Types context.
 *
 * @param  {string} ramlData - RAML file content.
 * @param  {string} rootFileDir - RAML file directory.
 * @returns  {Object} - RAML data types context.
 */
function getRAMLContext (ramlData, rootFileDir) {
  rootFileDir = rootFileDir || '.'
  var ast = yap.load(ramlData)
  var libraries = extractLibraries(ast, rootFileDir)
  var jsContent = {}
  traverse(jsContent, ast, rootFileDir, libraries)
  return jsContent.types
}

/**
 * restore ints and booleans stored as strings
 *
 * @param  {String} val - the value to be tested and possibly converted
 * @returns  {Mixed} - either a string, int or boolean.
 */
function destringify (val) {
  if (parseInt(val)) return parseInt(val)
  if (val === 'true') return true
  if (val === 'false') return false
  return val
}

/* Extract libraries used in an AST
 *
 * @param  {Object} ast - The ast to look in.
 * @param  {string} rootFileDir - RAML file directory.
 * @returns  {Object} - the libraries found as a js object.
 */
function extractLibraries (ast, rootFileDir) {
  if (ast.mappings === undefined) return {}
  var useStatement = ast.mappings.filter(function (e) {
    return e.key.value === 'uses'
  })
  if (useStatement[0] === undefined) return {}
  var libraries = useStatement[0].value.mappings.reduce(function (libs, e) {
    var libraryString = fs.readFileSync(path.join(rootFileDir, e.value.value))
    var libraryAst = yap.load(libraryString)
    var libraryJs = {}
    traverse(libraryJs, libraryAst, rootFileDir)
    libs[e.key.value] = libraryJs
    return libs
  }, {})
  var libs = Object.keys(libraries).reduce(function (lib, name) {
    lib[name] = {}
    Object.keys(libraries[name]).map(function (skip) {
      Object.keys(libraries[name][skip]).map(function (key) {
        lib[name][key] = libraries[name][skip][key]
      })
    })
    return lib
  }, {})
  return libs
}

/**
 * Matches a given string to a library namespace and
 * returns either the library (for a match) or the original
 * string (if no match)
 *
 * @param  {Object} libraries - The known libraries
 * @param  {String} value - The String to try as a namespace
 * @returns  {Mixed} - returns either a library, or the original value
 */
function libraryOrValue (libraries, value) {
  libraries = libraries || {}
  var namespace = value.split('.')
  var libNames = Object.keys(libraries)
  if (namespace.length !== 2) return value
  if (libNames.indexOf(namespace[0]) === -1) {
    return value
  } else if (Object.keys(libraries[namespace[0]]).indexOf(namespace[1]) === -1) {
    return value
  } else {
    return libraries[namespace[0]][namespace[1]]
  }
}

/**
 * traverses AST generated by yaml-ast-parser
 * and create json object..
 *
 * @param  {Object} obj - The object to hold the parsed raml
 * @param  {Object} ast - The ast from yaml-ast-parser
 * @param  {String} rootFileDir - a directory to be used
 *                  as cwd while resolving includes
 * @param  {Object} libraries - an object holding libraries to be used
 * @returns  {Object} - js object representing raml
 */
function traverse (obj, ast, rootFileDir, libraries) {
  function recurse (keys, currentNode) {
    if (currentNode.key) {
      keys = keys.concat([currentNode.key.value])
    }
    // kind 5 is an include
    if (currentNode.value && currentNode.value.kind === 5) {
      var location = currentNode.value.value
      var include
      // if it's an url, download it.
      if (location.slice(0, 4) === 'http') {
        var res = request('GET', location)
        var contentType = res.headers['content-type'].split(';')[0]
        include = res.getBody('utf8')
      // else it's a file, so read it
      } else {
        include = fs.readFileSync(path.join(rootFileDir, location))
      }
      // If it's json, parse it
      var ramlContentTypes = [
        'application/raml+yaml',
        'text/yaml',
        'text/x-yaml',
        'application/yaml',
        'application/x-yaml'
      ]
      if (path.extname(location) === '.json' || contentType === 'application/json') {
        deep(obj, keys.join('.'), JSON.parse(include))
        // If it's raml or yaml, parse it as raml
      } else if (['.raml', '.yaml', '.yml'].indexOf(path.extname(location)) > -1 || ramlContentTypes.indexOf(contentType) > -1) {
        currentNode.value = yap.load(include)
        recurse(keys, currentNode.value)
        // If it's anything else, just add it as a string.
      } else {
        currentNode.value = include
      }
    // a leaf node to be added
    } else if (currentNode.value && currentNode.value.value) {
      // if it looks like an int, it's an int
      var val = destringify(currentNode.value.value)
      val = libraryOrValue(libraries, currentNode.value.value)
      deep(obj, keys.join('.'), val)
    // a leaf that is an array
    } else if (currentNode.value && currentNode.value.items) {
      var values = currentNode.value.items.map(function (el) { return el.value })
      deep(obj, keys.join('.'), values)
    // an object that needs further traversal
    } else if (currentNode.mappings) {
      for (var i = 0; i < currentNode.mappings.length; i++) {
        recurse(keys, currentNode.mappings[i])
      }
    } else if (currentNode.key.value === 'examples') {
      var vals = currentNode.value.mappings.map(function (el) {
        return el.value.value
      })
      deep(obj, keys.join('.'), vals)
    // an object that needs further traversal
    } else if (currentNode.value && currentNode.value.mappings) {
      for (var o = 0; o < currentNode.value.mappings.length; o++) {
        recurse(keys, currentNode.value.mappings[o])
      }
    }
  }
  recurse([], ast)
}
/**
 * This callback accepts results converting RAML data type to JSON schema.
 *
 * @callback conversionCallback
 * @param {Error} err
 * @param {Object} schema
 */

/**
 * Set basePath to something other than cwd
 *
 * @param  {string} path - The path to be used as root for includes
 *
 */
function setBasePath (path) {
  basePath = path
}

/**
 * Convert RAML data type to JSON schema.
 *
 * @param  {string} ramlData - RAML file content.
 * @param  {string} typeName - Name of the type to be converted.
 * @param  {conversionCallback} cb - Callback to be called with converted value.
 */
function dt2js (ramlData, typeName, cb) {
  try {
    var ctx = getRAMLContext(ramlData, basePath)
  } catch (error) {
    cb(error, null)
    return
  }
  if (!(ctx instanceof Object)) {
    cb(new Error('Invalid RAML data'), null)
    return
  }

  if (ctx[typeName] === undefined) return cb(new Error('type ' + typeName + ' does not exist'))

  dtexp.expandedForm(ctx[typeName], ctx, function (err, expanded) {
    if (err) {
      cb(err, null)
      return
    }
    dtexp.canonicalForm(expanded, function (err, canonical) {
      if (err) {
        cb(err, null)
        return
      }
      try {
        var schema = schemaForm(canonical, [])
        schema = addRootKeywords(schema)
      } catch (error) {
        cb(error, null)
      }
      cb(err, schema)
    })
  })
}

/**
 * Add missing JSON schema root keywords.
 *
 * @param  {Object} schema
 * @returns  {Object}
 */
function addRootKeywords (schema) {
  schema['$schema'] = 'http://json-schema.org/draft-06/schema#'
  return schema
}

/**
 * Call `schemaForm` for each element of array.
 *
 * @param  {Array} arr
 * @param  {Array} reqStack - Stack of required properties.
 * @returns  {Array}
 */
function processArray (arr, reqStack) {
  var accum = []
  arr.forEach(function (el) {
    accum.push(schemaForm(el, reqStack))
  })
  return accum
}

/**
 * Change RAML type of data to valid JSON schema type.
 *
 * @param  {Object} data
 * @returns  {Object}
 */
function convertType (data) {
  switch (data.type) {
    case 'union':
      data['type'] = 'object'
      break
    case 'nil':
      data['type'] = 'null'
      break
    case 'file':
      data = convertFileType(data)
      break
  }
  return data
}

/**
 * Change RAML `file` type to proper JSON type.
 *
 * @param  {Object} data
 * @returns  {Object}
 */
function convertFileType (data) {
  data['type'] = 'string'
  data['media'] = {'binaryEncoding': 'binary'}
  if (data.fileTypes) {
    data['media']['anyOf'] = []
    data.fileTypes.forEach(function (el) {
      data['media']['anyOf'].push({'mediaType': el})
    })
    delete data.fileTypes
  }
  return data
}

/**
 * Change RAML date type of data to valid JSON schema type.
 *
 * @param  {Object} data
 * @returns  {Object}
 */
function convertDateType (data) {
  switch (data.type) {
    case 'date-only':
      data['type'] = 'string'
      data['pattern'] = constants.dateOnlyPattern
      break
    case 'time-only':
      data['type'] = 'string'
      data['pattern'] = constants.timeOnlyPattern
      break
    case 'datetime-only':
      data['type'] = 'string'
      data['pattern'] = constants.dateTimeOnlyPattern
      break
    case 'datetime':
      data['type'] = 'string'
      if (data.format === undefined || data.format.toLowerCase() === constants.RFC3339) {
        data['pattern'] = constants.RFC3339DatetimePattern
      } else if (data.format.toLowerCase() === constants.RFC2616) {
        data['pattern'] = constants.RFC2616DatetimePattern
      }
      delete data.format
      break
  }
  return data
}

/**
 * Change RAML displayName to JSON schema title.
 *
 * @param  {Object} data
 * @returns  {Object}
 */
function convertDisplayName (data) {
  data.title = data.displayName
  delete data.displayName
  return data
}

/**
 * Call `schemaForm` for all nested objects.
 *
 * @param  {Object} data
 * @param  {Array} reqStack - Stack of required properties.
 * @returns  {Object}
 */
function processNested (data, reqStack) {
  var updateWith = {}
  for (var key in data) {
    var val = data[key]

    if (val instanceof Array) {
      updateWith[key] = processArray(val, reqStack)
      continue
    }

    if (val instanceof Object) {
      updateWith[key] = schemaForm(val, reqStack, key)
      continue
    }
  }
  return updateWith
}

/**
 * Convert canonical form of RAML type to valid JSON schema.
 *
 * @param  {Object} data - Data to be converted.
 * @param  {Array} reqStack - Stack of required properties.
 * @param  {string} [prop] - Property name nested objects of which are processed.
 * @returns  {Object}
 */
function schemaForm (data, reqStack, prop) {
  if (!(data instanceof Object)) {
    return data
  }
  var lastEl = reqStack[reqStack.length - 1]
  if (data.required && lastEl && prop) {
    if (lastEl.props.indexOf(prop) > -1) {
      lastEl.reqs.push(prop)
    }
  }
  delete data.required
  var isObj = data.type === 'object'
  if (isObj) {
    reqStack.push({
      'reqs': [],
      'props': Object.keys(data.properties || {})
    })
  }

  var updateWith = processNested(data, reqStack)
  data = utils.updateObjWith(data, updateWith)
  if (isObj) {
    data.required = reqStack.pop().reqs
  }

  if (data.type) {
    data = convertType(data)
    data = convertDateType(data)
  }
  if (data.displayName) {
    data = convertDisplayName(data)
  }
  return data
}

module.exports.dt2js = dt2js
module.exports.setBasePath = setBasePath
