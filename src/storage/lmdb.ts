import * as fs from 'fs-extra'
import { Env, openDbi, Cursor } from 'node-lmdb'
import ArrayLikeIterable from '../util/ArrayLikeIterable'
import { Database } from './Database'

const STARTING_ARRAY = [null]
const AS_STRING = {
	asBuffer: false
}
const AS_BINARY = {
	keyIsBuffer: true
}
const READING_TNX = {
	readOnly: true
}
export const allDbs = new Map()
function genericErrorHandler(err) {
	if (err) {
		console.error(err)
	}
}
let env
export function open(name): Database {
	let location = './' + name
	try {
		fs.statSync(location)
	} catch (error) {
		fs.mkdirsSync(location)
	}
	try {
		fs.removeSync(location + '/LOCK') // clean up any old locks
	} catch(e) {}
	const env = new Env()
	env.open({
		path: location,
		mapSize: 1024*1024*1024, // maximum database size
		maxDbs: 1,
		noMetaSync: true,
		noSync: true,
		useWritemap: true,
		mapAsync: true,
	})
	let db = env.openDbi({
		name: 'data',
		create: true,
		keyIsBuffer: true,
	})
	const cobaseDb = {
		db,
		name,
		bytesRead: 0,
		bytesWritten: 0,
		reads: 0,
		writes: 0,
		getSync(id, asBuffer) {
			let txn = env.beginTxn(READING_TNX)
			let result = txn.getBinary(db, id, AS_BINARY)
			txn.abort()
			this.bytesRead += result && result.length || 1
			this.reads++
			if (result !== null) // missing entry, really should be undefined
				return result
		},
		get(id) {
			let txn = env.beginTxn(READING_TNX)
			let result = txn.getBinary(db, id, AS_BINARY)
			txn.abort()
			this.bytesRead += result && result.length || 1
			this.reads++
			if (result !== null) // missing entry, really should be undefined
				return result
		},
		putSync(id, value) {
			if (typeof value !== 'object') {
				throw new Error('putting string value')
				value = Buffer.from(value)
			}
			if (typeof id !== 'object') {
				throw new Error('putting string key')
				value = Buffer.from(value)
			}
			this.bytesWritten += value && value.length || 0
			this.writes++
			let txn = env.beginTxn()
			txn.putBinary(db, id, value, AS_BINARY)
			txn.commit()
		},
		put(id, value) {
			if (typeof value !== 'object') {
				throw new Error('putting string value')
				value = Buffer.from(value)
			}
			if (typeof id !== 'object') {
				throw new Error('putting string key')
				value = Buffer.from(value)
			}
			this.bytesWritten += value && value.length || 0
			this.writes++
			let txn = env.beginTxn()
			txn.putBinary(db, id, value, AS_BINARY)
			txn.commit()
		},
		remove(id) {
			if (typeof id !== 'object') {
				throw new Error('putting string')
				value = Buffer.from(value)
			}
			this.writes++
			let txn = env.beginTxn()
			txn.del(db, id)
			txn.commit()
		},
		removeSync(id) {
			if (typeof id !== 'object') {
				throw new Error('putting string')
				value = Buffer.from(value)
			}
			this.writes++
			let txn = env.beginTxn()
			txn.del(db, id)
			txn.commit()
		},
		iterator(options) {
			return db.iterator(options)
		},
		iterable(options) {
			let iterable = new ArrayLikeIterable()
			iterable[Symbol.iterator] = (async) => {
				let currentKey = options.reverse ? options.lt || Buffer.from([255, 255]) : (options.gt || Buffer.from([0]))
				let endKey = options.reverse ? options.gt || Buffer.from([0]) : (options.lt || Buffer.from([255, 255]))
				let reverse = options.reverse
				const goToDirection = reverse ? 'goToPrevious' : 'goToNext'
				const getNextBlock = () => {
					array = []
					let txn = env.beginTxn(READING_TNX)
					let cursor = new Cursor(txn, db, AS_BINARY)
					currentKey = cursor.goToRange(currentKey)
					let i = 0
					while (!(finished = currentKey === null || (reverse ? currentKey.compare(endKey) < 0 : currentKey.compare(endKey) > 0)) && i++ < 100) {
						array.push(currentKey, cursor.getCurrentBinary())
						currentKey = cursor[goToDirection]()
					}
					cursor.close()
					txn.commit()
				}
				let array
				let i = 0
				let finished
				getNextBlock()
				return {
					next() {
						let length = array.length
						if (i === length) {
							if (finished) {
								return { done: true }
							} else {
								getNextBlock()
								i = 0
								return this.next()
							}
						}
						let key = array[i++]
						let value = array[i++]
						cobaseDb.bytesRead += value && value.length || 0
						return {
							value: {
								key, value
							}
						}
					},
					return() {
						console.log('return called on iterator', this.ended)
						return { done: true }
					},
					throw() {
						console.log('throw called on iterator', this.ended)
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
			this.writes += operations.length
			this.bytesWritten += operations.reduce((a, b) => a + (b.value && b.value.length || 0), 0)
			let txn = env.beginTxn()
			for (let operation of operations) {
				if (typeof operation.key != 'object')
					throw new Error('non-buffer key')
				txn[operation.type === 'del' ? 'del' : 'putBinary'](db, operation.key, operation.value, AS_BINARY)
			}
			try {
				txn.commit()
			} catch (error) {
				txn.abort()
				error.message += 'trying to save batch ' + JSON.stringify(operations)
				throw error
			}
		},
		close() {
			db.close()
		},
		clear() {
			console.log('clearing db', name)
			db.drop()
			db = env.openDbi({
				name: 'data',
				create: true,
				keyIsBuffer: true,
			})
		}
	}
	allDbs.set(name, cobaseDb)
	return cobaseDb

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
