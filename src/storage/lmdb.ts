import * as fs from 'fs-extra'
import { Env, openDbi, Cursor } from 'node-lmdb'
import { compressSync, uncompressSync } from 'snappy'
import ArrayLikeIterable from '../util/ArrayLikeIterable'
import { Database } from './Database'
import when from '../util/when'

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
	fs.ensureDirSync(location.replace(/\/[^\/]+$/, ''))
	try {
		// move from directory to files of databases
		if (fs.statSync(location).isDirectory()) {
			fs.moveSync(location + '/data.mdb', location + '.mdb')
			fs.removeSync(location)
		}
	} catch (error) {
	}
	let startingSize = 0
	try {
		let stats = fs.statSync(location + '.mdb')
		// some unix platforms do not return an accurate size of the *used* space of the files (instead return allocated space), so use blocks to compute
		startingSize = process.platform == 'win32' ? stats.size : stats.blksize * stats.blocks
	} catch(e) {}

	let env = new Env()
	let db
	options = Object.assign({
		path: location + '.mdb',
		noSubdir: true,
		maxDbs: 1,
		noMetaSync: true, // much better performance with this
		mapSize: 16*1024*1024, // it can be as high 16TB
		noSync: true, // this makes dbs prone to corruption/lost data, but that is acceptable for cached data, and has much better performance.
		useWritemap: true, // it seems like this makes the dbs slightly more prone to corruption, but definitely still occurs without, and this provides better performance
	}, options)
	while(options.mapSize < startingSize * 2) {
		// make sure the starting map size is much bigger than the starting database file size
		options.mapSize *= 4
	}

	if (options && options.clearOnStart) {
		console.info('Removing', location + '.mdb')
		fs.removeSync(location + '.mdb')
		console.info('Removed', location + '.mdb')
	}
	env.open(options)
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
		env,
		name,
		bytesRead: 0,
		bytesWritten: 0,
		reads: 0,
		writes: 0,
		transactions: 0,
		readTxn: env.beginTxn(READING_TNX),
		transaction(execute, noSync) {
			let result
			if (this.writeTxn) {
				// already nested in a transaction, just execute and return
				result = execute()
				if (noSync)
					return result
				else
					return this.onDemandSync
			}
			let txn
			let committed
			try {
				if (!noSync)
					this.scheduleSync()
				this.transactions++
				txn = this.writeTxn = env.beginTxn()
				result = execute()
				txn.commit()
				committed = true
				if (noSync)
					return result
				else
					return this.onDemandSync
			} catch(error) {
				return handleError(error, this, txn, () => this.transaction(execute))
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
				} else {
					txn = this.readTxn
					txn.renew()
				}
				let result = txn.getBinaryUnsafe(db, id, AS_BINARY)
				result = result && uncompressSync(result)
				if (!writeTxn) {
					txn.reset()
				}
				this.bytesRead += result && result.length || 1
				this.reads++
				if (result !== null) // missing entry, really should be undefined
					return result
			} catch(error) {
				return handleError(error, this, txn, () => this.get(id))
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
				if (!this.writeTxn) {
					txn.commit()
					return this.scheduleSync()					
				}
			} catch(error) {
				if (this.writeTxn)
					throw error // if we are in a transaction, the whole transaction probably needs to restart
				return handleError(error, this, txn, () => this.put(id, value))
			}
		},
		remove(id) {
			let txn
			try {
				txn = this.writeTxn || env.beginTxn()
				this.writes++
				txn.del(db, id)
				if (!this.writeTxn) {
					txn.commit()
					return this.scheduleSync()
				}
				return true // object found and deleted
			} catch(error) {
				if (error.message.startsWith('MDB_NOTFOUND')) {
					if (!this.writeTxn)
						txn.abort()
					return false // calling remove on non-existent property is fine, but we will indicate its lack of existence with the return value
				}
				if (this.writeTxn)
					throw error // if we are in a transaction, the whole transaction probably needs to restart
				return handleError(error, this, txn, () => this.remove(id))
			}
		},
		removeSync(id) {
			this.remove(id)
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
					let cursor, txn = cobaseDb.readTxn
					try {
						txn.renew()
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
						txn.reset()
					} catch(error) {
						if (cursor) {
							try {
								cursor.close()
							} catch(error) { }
						}
						return handleError(error, this, txn, getNextBlock)
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
							// not an error
						} else {
							throw error
						}
					}
				}
				if (!this.writeTxn) {
					txn.commit()
					return this.scheduleSync()
				}
			} catch(error) {
				if (this.writeTxn)
					throw error // if we are in a transaction, the whole transaction probably needs to restart
				return handleError(error, this, txn, () => this.batch(operations))
			}
		},
		close() {
			db.close()
		},
		syncAverage: 100,
		scheduleSync() {
			let pendingPromise
			if (this.onDemandSync)
				return this.onDemandSync

			let scheduledMs = this.syncAverage * 100 // with no demand, we schedule syncs very slowly
			let currentTimeout
			const schedule = () => pendingPromise = new Promise((resolve, reject) => {
				when(this.currentSync, () => {
					//console.log('scheduling sync for', scheduledMs)
					currentTimeout = setTimeout(() => {
						currentTimeout = null
						let currentSync = this.currentSync = this.onDemandSync
						this.onDemandSync = null
						let start = Date.now()
						//console.log('syncing')
						this.sync((error) => {
							let elapsed = Date.now() - start
							//if (elapsed > 500)
						//		console.log('finished sync', name, elapsed)
							this.syncAverage = this.syncAverage / 1.1 + elapsed

							if (error) {
								console.error(error)
							}
							if (currentSync == this.currentSync) {
								this.currentSync = null
							}
							resolve()
							setTimeout(() => {}, 1) // this is to deal with https://github.com/Venemo/node-lmdb/issues/138
						})
					}, scheduledMs).unref()
				})
			})
			schedule()
			let immediateMode

			return this.onDemandSync = {
				then: (callback, errback) => { // this is a semi-lazy promise, we speed up the sync if we detect that someone is demanding a callback
					if (!immediateMode) {
						immediateMode = true
						scheduledMs = this.syncAverage
						if (currentTimeout) {
							// reschedule for sooner if it is waiting for the timeout to finish
							clearTimeout(currentTimeout)
							schedule()
						}
					}
					return pendingPromise.then(callback, errback)
				}
			}
		},
		sync(callback) {
			return env.sync(callback || function(error) {
				if (error) {
					console.error(error)
				}
			})
		},
		clear() {
			//console.log('clearing db', name)
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
	cobaseDb.readTxn.reset()
	allDbs.set(name, cobaseDb)
	return cobaseDb
	function handleError(error, db, txn, retry) {
		try {
			if (db && db.readTxn)
				db.readTxn.abort()
		} catch(error) {
		//	console.warn('txn already aborted')
		}
		try {
			if (db && db.writeTxn)
				db.writeTxn.abort()
		} catch(error) {
		//	console.warn('txn already aborted')
		}
		try {
			if (txn && txn !== (db && db.readTxn) && txn !== (db && db.writeTxn))
				txn.abort()
		} catch(error) {
		//	console.warn('txn already aborted')
		}

		if (db && db.writeTxn)
			db.writeTxn = null
		if (error.message == 'The transaction is already closed.') {
			try {
				db.readTxn = env.beginTxn(READING_TNX)
			} catch(error) {
				return handleError(error, db, null, retry)
			}
			return retry()
		}
		if (error.message.startsWith('MDB_MAP_FULL') || error.message.startsWith('MDB_MAP_RESIZED')) {
			const newSize = env.info().mapSize * 4
			console.log('Resizing database', name, 'to', newSize)
			env.resize(newSize)
			if (db) {
				db.readTxn = env.beginTxn(READING_TNX)
				db.readTxn.reset()
			}
			return retry()
		} else if (error.message.startsWith('MDB_PAGE_NOTFOUND') || error.message.startsWith('MDB_CURSOR_FULL') || error.message.startsWith('MDB_CORRUPTED') || error.message.startsWith('MDB_INVALID')) {
			// the noSync setting means that we can have partial corruption and we need to be able to recover
			if (db) {
				db.close()
			}
			try {
				env.close()
			} catch (error) {}
			console.warn('Corrupted database,', location, 'attempting to delete the db file and restart', error)
			fs.removeSync(location + '.mdb')
			env = new Env()
			env.open(options)
			return retry()
		}
		db.readTxn = env.beginTxn(READING_TNX)
		db.readTxn.reset()
		error.message = 'In database ' + name + ': ' + error.message
		throw error
	}
}
