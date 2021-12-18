import * as alkali from 'alkali'; const { VArray, ReplacedEvent, UpdateEvent, getNextVersion } = alkali.VArray ? alkali : alkali.default
import { Persistable, INVALIDATED_ENTRY, VERSION, Invalidated } from './Persisted.js'
import when from './util/when.js'
import ExpirationStrategy from './ExpirationStrategy.js'
import { OperationsArray, IterableOptions, Database } from './storage/Database.js'
import { asBinary } from 'lmdb'
//import { mergeProgress, registerProcessing, whenClassIsReady, DEFAULT_CONTEXT } from './UpdateProgress'

const expirationStrategy = ExpirationStrategy.defaultInstance
const DEFAULT_INDEXING_CONCURRENCY = 40
const INITIALIZING_LAST_KEY = Buffer.from([1, 7])
const INDEXING_MODE = { indexing: true }
const DEFAULT_INDEXING_DELAY = 60
const INITIALIZATION_SOURCE = 'is-initializing'
const INITIALIZATION_SOURCE_SET = new Set([INITIALIZATION_SOURCE])
const COMPRESSED_STATUS_24 = 254
const QUEUED_UPDATES = Symbol.for('qu')
export interface IndexRequest {
	previousEntry?: any
	pendingProcesses?: number[]
	deleted?: boolean
	sources?: Set<any>
	version: number
	triggers?: Set<any>
	previousValues?: Map
	value: {}
	by?: any
	resolveOnCompletion?: Function[]
}
interface IndexEntryUpdate {
	sources: Set<any>
	triggers?: Set<any>
}

class InitializingIndexRequest implements IndexRequest {
	version: number
	constructor(version) {
		this.version = version
	}
	get triggers() {
		return INITIALIZATION_SOURCE_SET
	}
	get previousVersion() {
		return -1
	}
}

const versionToDate = (version) =>
	new Date(version / 256 + 1500000000000).toLocaleString()

export const Index = ({ Source }) => {
	const Index = class extends KeyIndex {}
	Source.updateWithPrevious = true
	Index.sources = [ Index.source = Source ]
	Index.eventLog = []
	Index.queuedUpdateArrays = []
	Index.allQueuedUpdates = new Set()
	return Index
}

export class KeyIndex extends Persistable.as(VArray) {
	version: number
	averageConcurrencyLevel: number
	static whenProcessingComplete: Promise<any> // promise for the completion of processing in current indexing task for this index
	static whenCommitted: Promise<any> // promise for when an update received by this index has been fully committed (to disk)
	static indexingProcess: Promise<any>
	static eventLog = []
	static queuedUpdateArrays = []
	static derivedFrom(...sources: Array<Persisted | Function | {}>) {
		for (let source of sources) {
			if (source.notifies) {
				if (!this.sources)
					this.sources = []
				this.sources.push(this.source = source)
				source.updateWithPrevious = true
			} else if (typeof source === 'function') {
				this.indexBy = source
			} else {
				Object.assign(this, source)
			}
		}
/*		static whenProcessingComplete: Promise<any> // promise for the completion of processing in current indexing task for this index,
		whenCommitted: Promise<any> // promise for when an update received by this index has been fully committed (to disk),
		indexingProcess: Promise<any>*/
		this.eventLog = []
		this.queuedUpdateArrays = []
		this.allQueuedUpdates = new Set()
		this.start()
	}

	static forValue(id, transition) {
		return this.tryForQueueEntry(id, () => this.indexEntry(id, transition))
	}
	static forQueueEntry(id) {
		return this.tryForQueueEntry(id, () =>
			this.indexEntry(id).then(complete => {
				if (complete) {
					complete.commit()
				}
			})
		)
	}
	static async indexEntry(id, transition) {
		let { previousValue: previousData, deleted, sources, triggers, fromVersion: previousVersion } = transition || {}
		let operations: OperationsArray = []
		let eventUpdateSources = []

		let toRemove = new Map()
		// TODO: handle delta, for optimized index updaes
		// this is for recording changed entities and removing the values that previously had been indexed
		let previousEntries
		try {
			if (previousData != null) { // if no data, then presumably no references to clear
				// use the same mapping function to determine values to remove
				previousEntries = previousData === undefined ? previousData : this.indexBy(previousData, id)
				if (previousEntries && previousEntries.then)
					previousEntries = await previousEntries
				if (typeof previousEntries == 'object' && previousEntries) {
					previousEntries = this.normalizeEntries(previousEntries)
					for (let entry of previousEntries) {
						let previousValue = entry.value
						previousValue = this.db.encoder.encode(previousValue)
						toRemove.set(typeof entry === 'object' ? entry.key : entry, previousValue)
					}
				} else if (previousEntries != null) {
					toRemove.set(previousEntries, this.db.encoder.encode(previousEntries))
				}
			}
		} catch(error) {
			if (error.isTemporary)
				throw error
			//if (transition && transition.version !== version) return // don't log errors from invalidated states
			this.warn('Error indexing previous value', this.source.name, 'for', this.name, id, error)
		}
		//if (indexRequest && indexRequest.version !== version) return // if at any point it is invalidated, break out
		let entries
		if (!deleted) {
			let attempts = 0
			let data
			try {
				data = transition ? transition.value : this.source.get(id, INDEXING_MODE)
				if (data && data.then)
					data = await data
			} catch(error) {
				if (error.isTemporary)
					throw error
				try {
					// try again
					data = transition ? transition.value : await this.source.get(id, INDEXING_MODE)
				} catch(error) {
					//if (indexRequest && indexRequest.version !== version) return // if at any point it is invalidated, break out
					this.warn('Error retrieving value needing to be indexed', error, 'for', this.name, id)
					data = undefined
				}
			}
			//if (indexRequest && indexRequest.version !== version) return // if at any point it is invalidated, break out
			// let the indexBy define how we get the set of values to index
			try {
				entries = data === undefined ? data : this.indexBy(data, id)
				if (entries && entries.then)
					entries = await entries
			} catch(error) {
				if (error.isTemporary)
					throw error
				//if (indexRequest && indexRequest.version !== version) return // if at any point it is invalidated, break out
				this.warn('Error indexing value', error, 'for', this.name, id)
				entries = undefined
			}
			entries = this.normalizeEntries(entries)
			let first = true
			for (let entry of entries) {
				// we use the composite key, so we can quickly traverse all the entries under a certain key
				let key = typeof entry === 'object' ? entry.key : entry // TODO: Maybe at some point we support dates as keys
				// TODO: If toRemove has the key, that means the key exists, and we don't need to do anything, as long as the value matches (if there is no value might be a reasonable check)
				let removedValue = toRemove.get(key)
				// a value of '' is treated as a reference to the source object, so should always be treated as a change
				let value = this.db.encoder.encode(entry.value)
				first = false
				if (removedValue != null)
					toRemove.delete(key)
				let isChanged = removedValue == null || !value.equals(removedValue)
				if (isChanged || entry.value == null || this.alwaysUpdate) {
					if (isChanged) {
						let fullKey = [ key, id ]
						operations.push({
							key: fullKey,
							value: value
						})
						operations.byteCount = (operations.byteCount || 0) + value.length + fullKey.length
					}
					if (!this.resumePromise && this.listeners && this.listeners.length > 0)
						eventUpdateSources.push({ key, sources, triggers })
				}
			}
		}
		for (let [key] of toRemove) {
			/*if (fullKey.length > 510) {
				console.error('Too large of key indexing', this.name, key)
				continue
			}*/
			operations.push({
				key: [ key, id ]
			})
			if (!this.resumePromise && this.listeners && this.listeners.length > 0)
				eventUpdateSources.push({ key, sources, triggers })
		}
		if (Index.onIndexEntry) {
			Index.onIndexEntry(this.name, id, version, previousEntries, entries)
		}
		return {
			commit: () => {
				let batchFinished
				for (let operation of operations) {
					if (operation.value)
						batchFinished = this.db.put(operation.key, asBinary(operation.value))
					else
						batchFinished = this.db.remove(operation.key)
				}
				if (eventUpdateSources.length > 0) {
					return (batchFinished || Promise.resolve()).then(() =>
						this.queueUpdates(eventUpdateSources))
				}
			}
		}
	}
	static pendingEvents = new Map()

	static normalizeEntries(entries) {
		if (typeof entries != 'object') {
			// allow single primitive key
			return entries == null ? [] : [ entries ]
		} else if (entries instanceof Map) {
			return Array.from(entries).map(([ key, value ]) => ({ key, value }))
		} else if (!(entries instanceof Array)) {
			// single object
			if (entries === null)
				return []
			return [entries]
		}
		return entries
	}

	static log(...args) {
		this.eventLog.push(args.join(' ') + ' ' + new Date().toLocaleString())
		console.log(...args)
	}
	static warn(...args) {
		this.eventLog.push(args.join(' ') + ' ' + new Date().toLocaleString())
		console.warn(...args)
	}

	static updated(event, by) {
		// don't do anything, we don't want these events to propagate through here, and we do indexing based on upstream queue
	}

	static queueUpdates(eventSources) {
		if (!this.unsavedUpdates) {
			this.unsavedUpdates = []
			this.unsavedUpdates.id = this.unsavedQueuedId = (this.unsavedQueuedId || 0) + 1
			if (this.queuedUpdateArrays.length == 0)
				setTimeout(() =>
					this.processQueuedUpdates())
			this.queuedUpdateArrays.push(this.unsavedUpdates)
		}
		for ( const { key, triggers, sources } of eventSources) {
			if (!this.allQueuedUpdates.has(key)) {
				this.allQueuedUpdates.add(key)
				this.unsavedUpdates.push(key)
			}
		}
	}
	static async processQueuedUpdates() {
		let inProgress = []
		let delayMs = 0
		while (this.queuedUpdateArrays.length) {
			let updateArray = this.queuedUpdateArrays[0]
			let l = updateArray.length
			for (let i = updateArray.sent || 0; i < l; i++) {
				let key = updateArray[i]
				try {
					let event = new ReplacedEvent()
					this.allQueuedUpdates.delete(key)
					let start = process.hrtime.bigint()
					super.updated(event, { // send downstream
						id: key,
						constructor: this
					})
					let whenWritten = event.whenWritten
					if (whenWritten) {
						inProgress.push(event.whenWritten)
						if (inProgress.length > 20) {
							await Promise.all(inProgress)
							inProgress = []
						}
					}
					await delay(Number(process.hrtime.bigint() - start) / 1000000) // delay about the same amount of time the update took
				} catch (error) {
					this.warn('Error sending index updates', error)
				}
			}
			if (updateArray.written) {
				Promise.all(inProgress).then(() =>
					this.db.remove([QUEUED_UPDATES, updateArray.id]))
				this.queuedUpdateArrays.shift()
			}
			else {
				if (l == updateArray.length) {
					await Promise.all(inProgress)
					inProgress = []
				}
				if (l == updateArray.length && this.unsavedUpdates == updateArray) {
					this.unsavedUpdates = null // we sent all the entries before it was written, restart a new array
					this.queuedUpdateArrays.shift()
				}
				else
					updateArray.sent = l
			}
		}
	}
	static sendUpdates(eventSources) {
		let updatedIndexEntries = new Map<any, IndexEntryUpdate>()
		// aggregate them by key so as to minimize the number of events we send
		nextEvent: for ( const { key, triggers, sources } of eventSources) {
			let entry = updatedIndexEntries.get(key)
			if (!entry) {
				updatedIndexEntries.set(key, entry = {
					sources: new Set(),
					triggers: new Set(),
				})
			}
			if (triggers) {
				for (let trigger of triggers) {
					entry.triggers.add(trigger)
					if (trigger === INITIALIZATION_SOURCE) {
						continue nextEvent // don't record sources for initialization
					}
				}
			}
			if (sources)
				for (let source of sources)
					entry.sources.add(source)
		}

		let updatedIndexEntriesArray = Array.from(updatedIndexEntries).reverse()
		updatedIndexEntries = new Map()
		let indexedEntry
		while ((indexedEntry = updatedIndexEntriesArray.pop())) {
			try {
				let event = new ReplacedEvent()
				let indexEntryUpdate: IndexEntryUpdate = indexedEntry[1]
				event.sources = indexEntryUpdate.sources
				event.triggers = Array.from(indexEntryUpdate.triggers)
				super.updated(event, { // send downstream
					id: indexedEntry[0],
					constructor: this
				})
			} catch (error) {
				this.warn('Error sending index updates', error)
			}
		}
		this.instanceIds.updated()
	}

	static get(id) {
		// First: ensure that all the source instances are up-to-date
		return when(this.source.whenUpdatedInContext(true), () => {
			let iterable = this._getIndexedValues({
				start: id, // the range of everything starting with id-
				end: [id, '\u{ffff}'],
			})
			return this.returnsIterables ? iterable : iterable.asArray
		})
	}

	static getIndexedKeys(id) {
		return this._getIndexedValues({
			start: id, // the range of everything starting with id-
			end: [id, '\u{ffff}'],
			values: false,
		}, true)
	}

	static getIndexedValues(range: IterableOptions) {
		range = range || {}
		if (!this.initialized && range.waitForInitialization) {
			return this.start().then(() => this.getIndexedValues(range))
		}
		if (range.start === undefined)
			range.start = true
		return when(!range.noWait && this.whenUpdatedInContext(), () =>
			this._getIndexedValues(range, !range.onlyValues, range.useFullKey))
	}

	// Get a range of indexed entries for this id (used by Reduced)
	static _getIndexedValues(range: IterableOptions, returnKeys?: boolean, useFullKey?: boolean) {
		const db: Database = this.db
		let approximateSize = 0
		let promises = []
		return db.getRange(range).map(({ key, value }) => {
			let [, sourceId] = key
			/*if (range.recordApproximateSize) {
				let approximateSize = approximateSize += key.length + (value && value.length || 10)
			}*/
			let parsedValue = value == null ? this.source.get(sourceId) : value
			if (parsedValue && parsedValue.then) {
				return parsedValue.then(parsedValue => returnKeys ? {
					key: useFullKey ? key : sourceId,
					value: parsedValue,
				} : parsedValue)
			}
			return returnKeys ? {
				key: useFullKey ? key : sourceId,
				value: parsedValue,
			} : parsedValue
		})
	}
	/**
	* Indexing function, that defines the keys and values used in the indexed table.
	* This should be implemented by Index subclasses, and should be safe/functional
	* method with referential integrity (always returns the same results with same inputs),
	* as it is used to determine key/values on both addition and removal of entities.
	* @param data The object to be indexed
	* @return The return value can be an array of objects, where each object has a `key` and a `value`. It can only be an array of simple strings or numbers, if it is merely keys that need to be indexed, or even be a just a string (or number), if only a single key should be indexed
	**/
	static indexBy(data: {}, sourceKey: string | number | boolean): Array<{ key: string | number, value: any} | string | number> | IterableIterator<any> | string | number	{
		return null
	}

	static whenUpdatedInContext(context?) {
		return this.source.whenUpdatedInContext(true)
	}

	// static returnsIterables = true // maybe at some point default this to on

	static getInstanceIdsAndVersionsSince(version) {
		// There is no version tracking with indices.
		// however, indices always do send updates, and as long as we wait until we are ready and finished with initial indexing
		// downstream tables should have received all the updates they need to proceed
		//console.log('getInstanceIdsAndVersionsSince from KeyIndex', this.name, version)
		return this.ready.then(() => {
			//this.log('getInstanceIdsAndVersionsSince ready from KeyIndex', this.name, version)
			if (version == 0) { // if we are starting from scratch, we can return everything
				return when(this.getInstanceIds(), idsAndVersions => {
					idsAndVersions = idsAndVersions.map(id => ({
						id,
						version: getNextVersion(),
					}))
					idsAndVersions.isFullReset = true
					return idsAndVersions
				})
			}
			return []
		})
	}

	clearCache() {
		this.cachedValue = undefined
		this.cachedVersion = -1
	}

	valueOf() {
		return when(super.valueOf(true), (value) => {
			expirationStrategy.useEntry(this, (this.approximateSize || 100) * 10) // multiply by 10 because generally we want to expire index values pretty quickly
			return value
		})
	}

	static openDatabase() {
		let db = this.source.openChildDB(this)
		db.on('beforecommit', () => {
			if (this.unsavedUpdates && this.unsavedUpdates.length > 0) {
				this.unsavedUpdates.written = true
				db.put([QUEUED_UPDATES, this.unsavedQueuedId], this.unsavedUpdates)
				this.unsavedUpdates = null
			}
		})
		return false // is not root
	}
	static async initializeData() {
		await super.initializeData()
		let hadQueuedUpdates = this.queuedUpdateArrays.length > 0
		for (let { key, value } of this.db.getRange({
			start: [QUEUED_UPDATES, 0],
			end: [QUEUED_UPDATES, 1e30],

		})) {
			value.id = key[1]
			value.written = true
			this.unsavedQueuedId = Math.max(this.unsavedQueuedId || 0, value.id)
			this.queuedUpdateArrays.push(value)
			for (let updateId of value) {
				this.allQueuedUpdates.add(updateId)
			}
		}
		if (this.queuedUpdateArrays.length > 0 && !hadQueuedUpdates)
			this.processQueuedUpdates()
	}
	static getIdsFromKey(key) {
		return this.source.getIdsFromKey(key)
	}
	static updateDBVersion() {
		if (!this.source.wasReset) {// only reindex if the source didn't do it for use
			this.resumeFromKey = true
			this.db.putSync(INITIALIZING_LAST_KEY, true)
		}
		super.updateDBVersion()
	}

	static resumeQueue() {
		this.state = 'waiting for upstream source to build'
		// explicitly wait for source to finish resuming before our own resuming
		return when(this.source.resumePromise, () =>
			super.resumeQueue())
	}

	static async clearEntries(set) {
		let result
		let db = this.db
		let i = 1
		try {
			for (let key of db.getRange({
				start: true,
				values: false,
			})) {
				let [, sourceId] = key
				if (set.has(sourceId)) {
					result = db.removeSync(key)
				}
				if (i++ % 100000 == 0)
					await delay()
			}
		} catch(error) {
			console.error(error)
		}
		return result // just need to wait for last one to finish (guarantees all others are finished)
	}

	static myEarliestPendingVersion = 0 // have we registered our process, and at what version
	static whenAllConcurrentlyIndexing?: Promise<any> // promise if we are waiting for the initial indexing process to join the concurrent indexing mode
	static loadVersions() {
		// don't load versions
	}
	resetCache() {
		// don't reset any in the db, we are incrementally updating
		this.cachedValue = undefined
		this.updateVersion()
	}

	static get instances() {
		// don't load from disk
		return this._instances || (this._instances = [])
	}

	static getInstanceIds(range?: IterableOptions) {
		let db = this.db
		range = range || {}
		if (range.start === undefined)
			range.start = true
		let whenReady
		if (range.waitForAllIds) {
			whenReady = when(this.ready, () => when(this.resumePromise, () => this.whenProcessingComplete))
		}
		let lastKey
		range.values = false
		return when(whenReady, () =>
			db.getRange(range).map(( key ) => key[0]).filter(key => {
				if (key !== lastKey) { // skip multiple entries under one key
					lastKey = key
					return true
				}
			}))
	}
}
Index.from = (Source) => Index({ Source })
export default Index

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((resolve, reject) =>
	setTimeout(() => reject(new Error('Timeout waiting for indexing synchronization')), ms))])

let currentlyProcessing = new Set()

class IndexingCompletionEvent extends UpdateEvent {
	type = 'indexing-completion'
}
// write a 64-bit uint (could be optimized/improved)
function writeUInt(buffer, number, offset?) {
	buffer.writeUIntBE(number, (offset || 0) + 2, 6)
}
// read a 64-bit uint (could be optimized/improved)
function readUInt(buffer, offset?) {
	return buffer.readUIntBE((offset || 0) + 2, 6)
}

class IteratorThenMap<K, V> implements Map<K, V> {
	didIterator: boolean
	iterator: any
	deferredMap: Map<K, V>
	iterable: Iterable<V>
	deletedCount: number
	constructor(iterable, length, deferredMap) {
		this.iterable = iterable
		this.deferredMap = deferredMap || new Map()
		this.deferredMap.isReplaced = true
		this.deletedCount = 0
		this.length = length
	}
	[Symbol.iterator]() {
		if (this.didIterator) {
			return this.deferredMap[Symbol.iterator]()
		} else {
			this.didIterator = true
			return this.iterator = this.iterable.map(([id, value]) => {
				this.deferredMap.set(id, value)
				return [id, value]
			})[Symbol.iterator]()
		}
	}
	get size() {
		if (this.iterator && this.iterator.done)
			return this.deferredMap.size
		return this.length - this.deletedCount + this.deferredMap.size
	}
	set(id: K, value: V) {
		return this.deferredMap.set(id, value)
	}
	get(id) {
		return this.deferredMap.get(id)
	}
	delete(id) {
		this.deletedCount++
		return this.deferredMap.delete(id)
	}
}
const delay = (ms?) => new Promise(resolve => ms >= 1 ? setTimeout(resolve, ms) : setImmediate(resolve))
