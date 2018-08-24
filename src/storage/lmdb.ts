import * as fs from 'fs-extra'
import { Env, openDbi, Cursor } from 'node-lmdb'
import { compressSync, uncompressSync } from 'snappy'
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
export function open(name, options): Database {
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
	env.open(Object.assign({
		path: location,
		maxDbs: 1,
		noMetaSync: true,
		mapSize: 16*1024*1024, // it can be as high 16TB
		noSync: true,
		useWritemap: true,
		mapAsync: true,
	}, options))
	let db
	function openDB() {
		try {
			db = env.openDbi({
				name: 'data',
				create: true,
				keyIsBuffer: true,
			})
		} catch(error) {
			handleError(error, null, null, openDB)
		}
	}
	openDB()
	const cobaseDb = {
		db,
		name,
		bytesRead: 0,
		bytesWritten: 0,
		reads: 0,
		writes: 0,
		transaction(execute) {
			if (this.writeTxn) {
				// already nested in a transaction, just execute and return
				return execute()
			}
			let txn
			let result
			let committed
			try {
				txn = this.writeTxn = env.beginTxn()
				result = execute()
				txn.commit()
				committed = true
				return result
			} catch(error) {
				handleError(error, this, txn, () => this.transaction(execute))
			} finally {
				if (!committed) {
					try {
						txn.abort()
					} catch(error) {}
				}
				this.writeTxn = null
			}
		},
		getSync(id, asBuffer) {
			return this.get(id, asBuffer)
		},
		get(id) {
			let txn
			try {
				const writeTxn = this.writeTxn
				if (writeTxn) {
					txn = writeTxn
				} else
					txn = env.beginTxn(READING_TNX)
				let result = txn.getBinaryUnsafe(db, id, AS_BINARY)
				result = result && uncompressSync(result)
				if (!writeTxn) {
					txn.abort()
				}
				this.bytesRead += result && result.length || 1
				this.reads++
				if (result !== null) // missing entry, really should be undefined
					return result
			} catch(error) {
				handleError(error, this, txn, () => this.get(id))
			}
		},
		putSync(id, value) {
			return this.put(id, value)
		},
		put(id, value) {
			let txn
			try {
				if (typeof value !== 'object') {
					throw new Error('putting string value')
					value = Buffer.from(value)
				}
				const compressedValue = compressSync(value)
				this.bytesWritten += compressedValue && compressedValue.length || 0
				this.writes++
				txn = this.writeTxn || env.beginTxn()
				txn.putBinary(db, id, compressedValue, AS_BINARY)
				if (!this.writeTxn)
					txn.commit()
			} catch(error) {
				if (this.writeTxn)
					throw error // if we are in a transaction, the whole transaction probably needs to restart
				handleError(error, this, txn, () => this.put(id, value))
			}
		},
		remove(id) {
			let txn
			try {
				txn = this.writeTxn || env.beginTxn()
				this.writes++
				txn.del(db, id)
				if (!this.writeTxn)
					txn.commit()
				return true // object found and deleted
			} catch(error) {
				if (error.message.startsWith('MDB_NOTFOUND')) {
					txn.abort()
					return false // calling remove on non-existent property is fine, but we will indicate its lack of existence with the return value
				}
				if (this.writeTxn)
					throw error // if we are in a transaction, the whole transaction probably needs to restart
				handleError(error, this, txn, () => this.remove(id))
			}
		},
		removeSync(id) {
			this.remove(id)
		},
		iterator(options) {
			return db.iterator(options)
		},
		iterable(options) {
			let iterable = new ArrayLikeIterable()
			iterable[Symbol.iterator] = (async) => {
				let currentKey = options.start || (options.reverse ? Buffer.from([255, 255]) : Buffer.from([0]))
				let endKey = options.end || (options.reverse ? Buffer.from([0]) : Buffer.from([255, 255]))
				const reverse = options.reverse
				let count = 0
				const goToDirection = reverse ? 'goToPrev' : 'goToNext'
				const getNextBlock = () => {
					array = []
					let txn, cursor
					try {
						txn = env.beginTxn(READING_TNX)
						cursor = new Cursor(txn, db, AS_BINARY)
						if (reverse) {
							// for reverse retrieval, goToRange is backwards because it positions at the key equal or *greater than* the provided key
							let nextKey = cursor.goToRange(currentKey)
							if (nextKey) {
								if (!nextKey.equals(currentKey)) {
									// goToRange positioned us at a key after the provided key, so we need to go the previous key to be less than the provided key
									currentKey = cursor.goToPrev()
								} // else they match, we are good, and currentKey is already correct
							} else {
								// likewise, we have been position beyond the end of the index, need to go to last
								currentKey = cursor.goToLast()
							}
						} else {
							// for forward retrieval, goToRange does what we want
							currentKey = cursor.goToRange(currentKey)
						}
						let i = 0
						while (!(finished = currentKey === null || (reverse ? currentKey.compare(endKey) <= 0 : currentKey.compare(endKey) >= 0)) && i++ < 100) {
							array.push(currentKey, uncompressSync(cursor.getCurrentBinaryUnsafe()))
							if (count++ >= options.limit) {
								finished = true
								break
							}
							currentKey = cursor[goToDirection]()
						}
						cursor.close()
						txn.commit()
					} catch(error) {
						if (cursor) {
							try {
								cursor.close()
							} catch(error) { }
						}
						handleError(error, this, txn, getNextBlock)
					}
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
			return db.batch(operations)
		},
		batch(operations) {
			this.writes += operations.length
			this.bytesWritten += operations.reduce((a, b) => a + (b.value && b.value.length || 0), 0)
			let txn
			try {
				txn = this.writeTxn || env.beginTxn()
				for (let operation of operations) {
					if (typeof operation.key != 'object')
						throw new Error('non-buffer key')
					try {
						let value = operation.value && compressSync(operation.value)
						txn[operation.type === 'del' ? 'del' : 'putBinary'](db, operation.key, value, AS_BINARY)
					} catch (error) {
						if (error.message.startsWith('MDB_NOTFOUND')) {
							console.warn('MDB_NOTFOUND errors may safely be ignored', error)
						} else {
							throw error
						}
					}
				}
				if (!this.writeTxn)
					txn.commit()
			} catch(error) {
				if (this.writeTxn)
					throw error // if we are in a transaction, the whole transaction probably needs to restart
				handleError(error, this, txn, () => this.batch(operations))
			}
		},
		close() {
			db.close()
		},
		clear() {
			console.log('clearing db', name)
			try {
				db.drop({
					justFreePages: true,
					txn: this.writeTxn,
				})
			} catch(error) {
				handleError(error, this, null, () => this.clear())
			}
		}
	}
	allDbs.set(name, cobaseDb)
	return cobaseDb
	function handleError(error, db, txn, retry) {
		try {
			if (txn)
				txn.abort()
		} catch(error) {
		//	console.warn('txn already aborted')
		}
		if (error.message.startsWith('MDB_MAP_FULL') || error.message.startsWith('MDB_MAP_RESIZED')) {
			if (db && db.readTxn) {
				try {
					db.readTxn.abort()
				} catch(error) {}
				db.readTxn = null // needs to be closed and recreated during resize
			}
			if (db && db.writeTxn) {
				try {
					db.writeTxn.abort()
				} catch(error) {}
				db.writeTxn = null // needs to be closed and recreated during resize
			}
			const newSize = env.info().mapSize * 4
			console.log('Resizing database', name, 'to', newSize)
			env.resize(newSize)
			return retry()
		}
		error.message = 'In database ' + name + ': ' + error.message
		throw error
	}
}
