import * as fs from 'fs-extra'
import * as leveldown from 'leveldown'
import ArrayLikeIterable from '../util/ArrayLikeIterable'

const STARTING_ARRAY = [null]
const AS_STRING = {
  asBuffer: false
}
function genericErrorHandler(err) {
  if (err) {
    console.error(err)
  }
}

try {
  fs.statSync('cachedb')
} catch (error) {
  fs.mkdirSync('cachedb')
}
try {
  fs.statSync('portaldb')
} catch (error) {
  fs.mkdirSync('portaldb')
}

export function open(name) {
  let location = './' + name
  try {
    fs.removeSync(location + '/LOCK') // clean up any old locks
  } catch(e) {}
  let db = leveldown(location)

  db.openSync()
  return {
    db,
    getSync(id, asBuffer) {
      try {
        let result = db.getSync(id, asBuffer ? undefined : AS_STRING)
        return (asBuffer && result) ? Buffer.from(result) : result
      } catch (error) {
        if (error.message.startsWith('NotFound')) {
          return
        } else {
          throw error
        }
      }
    },
    get(id) {
      return new Promise((resolve, reject) => {
        let callback = (err, value) => {
          if (err) {
            if (err.message.startsWith('NotFound')) {
              resolve(null)
            } else {
              if (err.message.indexOf('Corruption') == 0) {
                alterDatabase('repair')
              }
              console.error('error', err, db.location)
              if (err.message.indexOf('not open') > 0) {
  //              process.exit()
              }
              reject(err)
            }
          } else {
            resolve(value)
          }
        }
        db.get(id, callback)
      })
    },
    putSync(id, value) {
      db.putSync(id, value)
    },
    put(id, value) {
      return new Promise((resolve, reject) => {
        let callbacks = []
        db.put(id, value, (err, value) => {
          if (err) {
            if (err.message.indexOf('Corruption') == 0) {
              alterDatabase('repair')
            }
            reject(err)
          } else {
            resolve(value)
          }
        })
      })
    },
    remove(id) {
      return new Promise((resolve, reject) => {
        db.del(id, (err, value) => {
          if (err) {
            if (err.notFound) {
              resolve(null)
            } else {
              if (err.message.indexOf('Corruption') == 0) {
                alterDatabase('repair')
              }
              reject(err)
            }
          } else {
            resolve(value)
          }
        })
      })
    },
    removeSync(id) {
      return db.delSync(id)
    },
    iterator(options) {
      return db.iterator(options)
    },
    iterable(options) {
      let iterable = new ArrayLikeIterable()
      iterable[Symbol.iterator] = (async) => {
        options.valueAsBuffer = false
        let iterator = db.iterator(options)
        let array = STARTING_ARRAY
        let i = 1
        let finished
        return {
          next() {
            let length = array.length
            if (i === length) {
              if (finished || i === 0) {
                if (!this.ended) {
                  this.ended = true
                  iterator.binding.end(genericErrorHandler)
                }
                return { done: true }
              } else {
                if (async) {
                  return new Promise((resolve, reject) =>
                    iterator.binding.next((err, nextArray, nextFinished) => {
                      if (err) {
                        reject(err)
                      } else {
                        array = nextArray
                        finished = nextFinished
                        i = 0
                        resolve(this.next())
                      }
                    }))
                } else {
                  console.log('calling nextSync')
                  array = iterator.binding.nextSync()
                  console.log('finished nextSync', array.length)
                  i = 0
                  finished = array.finished // defined as a property on the sync api
                  return this.next()
                }
              }
            }
            let key, value
            if (options.reverse) {
              key = array[length - ++i]
              value = array[length - ++i]
            } else {
              value = array[i++]
              key = array[i++]
            }
            return {
              value: {
                key, value
              }
            }
          },
          return() {
            console.log('return called on iterator', this.ended)
            if (!this.ended) {
              this.ended = true
              iterator.binding.end(genericErrorHandler)
            }
            return { done: true }
          },
          throw() {
            console.log('throw called on iterator', this.ended)
            if (!this.ended) {
              this.ended = true
              iterator.binding.end(genericErrorHandler)
            }
            return { done: true }
          }
        }
      }
      return iterable
    },
    iterateSync(options, callback) {
      // This currently causes Node to crash
      if (!leveldown.fixed)
        throw new Error('Unstable function')
      options.keyAsBuffer = false
      options.valueAsBuffer = false
      let iterator = db.iterator(options)
      let nextResult

      while ((nextResult = iterator.nextSync()).length > 0) {
        if (options.gt == '0')
          console.log('next returned',nextResult)
        for (let i = 0, l = nextResult.length; i < l;) {
          let value = nextResult[i++]
          let key = nextResult[i++]
          callback(key, value)
        }
      }
      if (options.gt == '0')
        console.log('end')
      // clean up iterator
      iterator.endSync()
    },
    batchSync(operations) {
      return db.batchSync(operations)
    },
    batch(operations) {
      return new Promise((resolve, reject) => {
        db.batch(operations, (err, value) => {
          if (err) {
            if (err.message.indexOf('Corruption') == 0) {
              alterDatabase('repair')
            }
            reject(err)
          } else {
            resolve(value)
          }
        })
      })
    },
    close() {
      return new Promise((resolve, reject) =>
        db.close((err, value) => {
          if (err)
            reject(err)
          else
            resolve()
        }))
    },
    clear() {
      console.log('clearing database', db.location)
      db.closeSync()
      console.log('closed database, removing files')
      db.closeSync()
      fs.removeSync(db.location)
      db.openSync()
      console.log('cleared database', db.location)
    }
  }

  function alterDatabase(action) {
    if (db.repairing) {
      return db.repairing
    }
    let location = db.location
    console.info(action + 'ing database at ' + location)
    return db.repairing = new Promise((resolve, reject) => {
      // suspend all activity on the db
      let queued = []
      let originalGet = db.get
      db.get = function(...args) {
        console.log('queueing get', location)
        queued.push(() => {
          console.log('finishing get')
          db.get(...args)
        })
      }
      let originalPut = db.put
      db.put = function(...args) {
        console.log('queueing put', location)
        queued.push(() => {
          console.log('finishing put')
          db.put(...args)
        })
      }
      let originalDel = db.del
      db.del = function(...args) {
        console.log('queueing del', location)
        queued.push(() => {
          console.log('finishing del')
          db.del(...args)
        })
      }
      let originalBatch = db.batch
      db.batch = function(...args) {
        console.log('queueing batch', location)
        queued.push(() => {
          console.log('finishing batch')
          db.batch(...args)
        })
      }
      // close it down
      db.close((error) => {
        if (error) {
          console.error('Error closing db', error)
        }
        // do the repair
        leveldown[action](location, (err) => {
          if (err) {
            console.error('Failed to ' + action + ' database at ' + location, err)
          } else {
            console.info('Finished ' + action + 'ing database at ' + location)
          }
          db.open((error) => {
            if (error) {
              console.error('Error opening db', error)
              reject(error)
            }
            // resume
            db.repairing = false
            console.info('Resuming database operations at ' + location)
            db.get = originalGet
            db.put = originalPut
            db.batch = originalBatch
            db.del = originalDel
            for (let action of queued) {
              action()
            }
            resolve()
          })
        })
      })
    })
  }
}
