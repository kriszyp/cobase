import { Readable } from 'stream'
import { Context } from 'alkali'
import when from './util/when'
const BUFFER_SIZE = 10000
const COMMA = Buffer.from(',')
const OPEN_CURLY = Buffer.from('{')
const CLOSE_CURLY = Buffer.from('}')
const OPEN_BRACKET = Buffer.from('[')
const CLOSE_BRACKET = Buffer.from(']')

// a readable stream for serializing a set of variables to a JSON stream
export class JSONStream extends Readable {
  constructor(options) {
    // Calls the stream.Readable(options) constructor
    super(options)
    this.context = new Context(options.user)
    this.context.addInput = () => {} // make sure we don't store references that leak memory
    this.context.preferJSON = true
    this.buffer = []
    this.bufferSize = 0
    this.iterator = this.serialize(options.value, true)
    this.id = Math.random()
  }

  *serialize(object, containsVariables) {
    // using a generator to serialize JSON for convenience of recursive pause and resume functionality
    // serialize a value to an iterator that can be consumed by streaming API
    if (object && typeof object === 'object') {
      if (object.asJSON) {
        yield object.asJSON
        return
      }
      if (object[Symbol.iterator] && !object.then) {
        yield '['
        let first = true
        if (object[Symbol.asyncIterator] && !(object instanceof Array)) {
          let iterator = object[Symbol.asyncIterator]()
          let iteratorResult
          do {
            iteratorResult = iterator.next()
            if (iteratorResult.then) {
              yield iteratorResult.then(result => {
                iteratorResult = result
                return ''
              })
            }
            if (iteratorResult.done) {
              yield ']'
              return
            } else {
              if (first) {
                first = false
              } else {
                yield ','
              }
              yield* this.serialize(iteratorResult.value)
            }
          } while(true)
        }
        for (let element of object) {
          if (first) {
            first = false
          } else {
            yield ','
          }
          yield* this.serialize(element)
        }
        yield ']'
        return
      }
      containsVariables = containsVariables || object.containsVariables
      if (object.then) {
        try {
          yield this.context.executeWithin(() =>
            object.then(object => this.serialize(object, containsVariables), handleError))
        } catch (error) {
          object = handleError(error)
        }
      } else if (object.asJSON) {
        yield object.asJSON
      } else if (containsVariables) {
        yield '{'
        let first = true
        for (let key in object) {
          if (first) {
            first = false
          } else {
            yield ','
          }
          yield JSON.stringify(key) + ':'
          yield* this.serialize(object[key])
        }
        yield '}'
      } else {
        yield JSON.stringify(object)
      }
    } else {
      yield JSON.stringify(object)
    }
  }

  _read() {
    if (this._amReading) {
      // I don't know why _read is called from within a push call, but if we are already reading, ignore the call
      return
    }
    this._amReading = true
    if (this.done) {
      return this.push(null)
    }
    when(this.readIterator(this.iterator), done => {
      if (done) {
        this.done = true
        this.push(null)
      } else {
        this._amReading = false
      }
    }, error => {
      console.error(error)
      this.done = true
      this.push(error.toString())
      this.push(null)
    })
  }

  push(content) {
    if (content === null || content instanceof Buffer) {
      if (this.bufferSize > 0)
        this.flush()
      return super.push(content)
    }
    this.bufferSize += content.length || content.toString().length
    this.buffer.push(content)
    if (this.bufferSize > BUFFER_SIZE) {
      return this.flush()
    }
    return true
  }

  flush() {
    let pushResult = super.push(this.buffer.join(''))
    this.buffer = []
    this.bufferSize = 0
    return pushResult
  }

  readIterator(iterator) {
    try { // eventually we should be able to just put this around iterator.next()
      let nextString
      if (iterator.childIterator) {
        // resuming in a child iterator
        return when(this.readIterator(iterator.childIterator), done => {
          if (done) {
            iterator.childIterator = null
            // continue on with the current iterator
            return this.readIterator(iterator)
          }
        })
      }
      do {
        let stepReturn = iterator.next()
        if (stepReturn.done) {
          return true
        }
        nextString = stepReturn.value
        if (nextString == null) {
          nextString = 'null'
        } else {
          if (nextString.then) {
            this.flush()
            return nextString.then((resolved) => {
              if (resolved && typeof resolved.return === 'function') {
                iterator.childIterator = resolved
                return this.readIterator(iterator)
              } else if (this.push(resolved + '')) {
                return this.readIterator(iterator)
              } // else return false
            })
          }
          if (typeof nextString.return === 'function') {
            iterator.childIterator = nextString
            return this.readIterator(iterator)
          }
        }
      } while (this.push(nextString))
    } catch (error) {
      console.error(error)
      this.push(error.toString())
      this.push(null)
      return true
    }
  }
}

function handleError(error) {
  console.error(error)
  return JSON.stringify(error.toString())
}
