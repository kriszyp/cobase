import { currentContext, VArray, ReplacedEvent, UpdateEvent, getNextVersion } from 'alkali'
import { serialize, parse, parseLazy, createParser, asBlock } from 'dpack'
import { Persistable, INVALIDATED_ENTRY, VERSION, Invalidated } from './Persisted'
import { ShareChangeError } from './util/errors'
import { toBufferKey, fromBufferKey } from 'ordered-binary'
import when from './util/when'
import ExpirationStrategy from './ExpirationStrategy'
import { OperationsArray, IterableOptions, Database } from './storage/Database'
import { DEFAULT_CONTEXT } from './RequestContext'
//import { mergeProgress, registerProcessing, whenClassIsReady, DEFAULT_CONTEXT } from './UpdateProgress'

const expirationStrategy = ExpirationStrategy.defaultInstance
const DEFAULT_INDEXING_CONCURRENCY = 40
const SEPARATOR_BYTE = Buffer.from([30]) // record separator control character
const SEPARATOR_NEXT_BYTE = Buffer.from([31])
const INDEXING_STATE = Buffer.from([1, 5])
const INITIALIZING_LAST_KEY = Buffer.from([1, 7])
const EMPTY_BUFFER = Buffer.from([])
const INDEXING_MODE = { indexing: true }
const DEFAULT_INDEXING_DELAY = 60
const INITIALIZATION_SOURCE = 'is-initializing'
const INDEXING_STATE_SIZE = 3584 // good size for ensuring that it is an (and only one) overflow page in LMDB, and won't be moved
const INITIALIZATION_SOURCE_SET = new Set([INITIALIZATION_SOURCE])
const COMPRESSION_THRESHOLD = 1500
const COMPRESSED_STATUS_24 = 254
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
	Source.updateWithPrevious = true
	let lastIndexedVersion = 0
	const sourceVersions = {}
	const processingSourceVersions = new Map<String, number>()
	let pendingProcesses = false
	let stateOffset = 0
	// this is shared memory buffer between processes where we define what each process is currently indexing, so processes can determine if there are potentially conflicts
	// in what is being processed
	let indexingState: Buffer

	return class extends Persistable.as(VArray) {
		version: number
		averageConcurrencyLevel: number
		static Sources = [Source]
		static whenProcessingComplete: Promise<any> // promise for the completion of processing in current indexing task for this index
		static whenCommitted: Promise<any> // promise for when an update received by this index has been fully committed (to disk)
		static indexingProcess: Promise<any>
		static eventLog = []

		static forValue(id, value, indexRequest) {
			indexRequest.value = value
			return this.indexEntry(id, indexRequest)
		}
		static forQueueEntry([id, indexRequest]) {
			this.indexEntry(id, indexRequest).then(complete => {
				if (complete) {
					this.queue.delete(id)
					complete.commit()
				}
			})
		}
		static async indexEntry(id, indexRequest: IndexRequest) {
			let { previousEntry, deleted, sources, triggers, version } = indexRequest || {}
			let operations: OperationsArray = []
			let previousVersion = previousEntry && previousEntry.version
			let eventUpdateSources = []
			let idAsBuffer = toBufferKey(id)

			try {
				let toRemove = new Map()
				// TODO: handle delta, for optimized index updaes
				// this is for recording changed entities and removing the values that previously had been indexed
				let previousEntries
				try {
					if (previousEntry !== undefined) { // if no data, then presumably no references to clear
						// use the same mapping function to determine values to remove
						let previousData = previousEntry.value
						previousEntries = this.indexBy(previousData, id)
						console.log({previousEntries})
						if (previousEntries && previousEntries.then)
							previousEntries = await previousEntries
						if (typeof previousEntries == 'object' && previousEntries) {
							previousEntries = this.normalizeEntries(previousEntries)
							for (let entry of previousEntries) {
								let previousValue = entry.value
								previousValue = previousValue === undefined ? EMPTY_BUFFER : this.serialize(previousValue, false, 0)
								toRemove.set(typeof entry === 'object' ? entry.key : entry, previousValue)
							}
						} else if (previousEntries != null) {
							toRemove.set(previousEntries, EMPTY_BUFFER)
						}
					}
				} catch(error) {
					if (error.isTemporary)
						throw error
					if (indexRequest.version !== version) return // don't log errors from invalidated states
					this.warn('Error indexing previous value', Source.name, 'for', this.name, id, error)
				}
				if (indexRequest.version !== version) return // if at any point it is invalidated, break out
				let entries
				if (!deleted) {
					let attempts = 0
					let data
					try {
						data = Source.get(id, INDEXING_MODE)
						if (data && data.then)
							data = await data
					} catch(error) {
						if (error.isTemporary)
							throw error
						try {
							// try again
							data = 'value' in indexRequest ? indexRequest.value : await Source.get(id, INDEXING_MODE)
						} catch(error) {
							if (indexRequest.version !== version) return // if at any point it is invalidated, break out
							this.warn('Error retrieving value needing to be indexed', error, 'for', this.name, id)
							data = undefined
						}
					}
					if (Source.whenValueCommitted && Source.whenValueCommitted.then)
						await Source.whenValueCommitted
					if (indexRequest.version !== version) return // if at any point it is invalidated, break out
					// let the indexBy define how we get the set of values to index
					try {
						entries = data === undefined ? data : this.indexBy(data, id)
						if (entries && entries.then)
							entries = await entries
					} catch(error) {
						if (error.isTemporary)
							throw error
						if (indexRequest.version !== version) return // if at any point it is invalidated, break out
						this.warn('Error indexing value', error, 'for', this.name, id)
						entries = undefined
					}
					entries = this.normalizeEntries(entries)
					console.log({entries})
					let first = true
					for (let entry of entries) {
						// we use the composite key, so we can quickly traverse all the entries under a certain key
						let key = typeof entry === 'object' ? entry.key : entry // TODO: Maybe at some point we support dates as keys
						// TODO: If toRemove has the key, that means the key exists, and we don't need to do anything, as long as the value matches (if there is no value might be a reasonable check)
						let removedValue = toRemove.get(key)
						// a value of '' is treated as a reference to the source object, so should always be treated as a change
						let dpackStart = this._dpackStart
						let value = entry.value == null ? EMPTY_BUFFER : this.serialize(asBlock(entry.value), first, dpackStart)
						first = false
						if (removedValue != null)
							toRemove.delete(key)
						let isChanged = removedValue == null || !value.slice(dpackStart).equals(removedValue)
						if (isChanged || value.length === 0 || this.alwaysUpdate) {
							if (isChanged) {
								let fullKey = Buffer.concat([toBufferKey(key), SEPARATOR_BYTE, idAsBuffer])
								value = this.setupSizeTable(value, dpackStart, 0)
								if (value.length > COMPRESSION_THRESHOLD) {
									value = this.compressEntry(value, 0)
								}
								operations.push({
									type: 'put',
									key: fullKey,
									value: value
								})
								operations.byteCount = (operations.byteCount || 0) + value.length + fullKey.length
							}
							eventUpdateSources.push({ key, sources, triggers })
						}
					}
				}
				for (let [key] of toRemove) {
					operations.push({
						type: 'del',
						key: Buffer.concat([toBufferKey(key), SEPARATOR_BYTE, idAsBuffer])
					})
					eventUpdateSources.push({ key, sources, triggers })
				}
				if (Index.onIndexEntry) {
					Index.onIndexEntry(this.name, id, version, previousEntries, entries)
				}
			} catch(error) {
				if (error.isTemporary) {
					let retries = indexRequest.retries = (indexRequest.retries || 0) + 1
					this.state = 'retrying index in ' + retries * 1000 + 'ms'
					if (retries < 4) {
						await this.delay(retries * 1000)
						console.info('Retrying index entry', this.name, id, error)
						return
					} else {
						console.info('Too many retries', this.name, id, retries)
					}
				}
				if (indexRequest.version !== version) return // if at any point it is invalidated, break out, don't log errors from invalidated states
				this.warn('Error indexing', Source.name, 'for', this.name, id, error)
			}
			console.log({operations})
			return {
				commit: (lastVersion) => {
					let batchFinished
					console.log('KeyIndex commit', operations)
					if (operations.length > 0) {
						batchFinished = this.db.batch(operations)
					}
					if (eventUpdateSources.length > 0) {
						this.lastUpdate = lastVersion
						return (batchFinished || Promise.resolve()).then(() =>
							this.sendUpdates(eventUpdateSources))
					}
				}
			}
		}
		static pendingEvents = new Map()

		static normalizeEntries(entries) {
			if (typeof entries != 'object') {
				// allow single primitive key
				return entries == null ? [] : [entries]
			} else if (entries instanceof Map) {
				return Array.from(entries).map(([ key, value]) => ({ key, value }))
			} else if (!(entries instanceof Array)) {
				// single object
				if (entries === null)
					return []
				return [entries]
			}
			return entries
		}

		static serialize(value, firstValue, startOffset) {
			try {
				return serialize(value, {
					startOffset,
					shared: this.sharedStructure,
					avoidShareUpdate: !firstValue
				})
			} catch (error) {
				if (error instanceof ShareChangeError) {
					this.warn('Reserializing after share change in another process', this.name)
					return this.serialize(value, firstValue, startOffset)
				}
				else
					throw error
			}
		}
		static rebuildIndex() {
			this.rebuilt = true
			lastIndexedVersion = 1

			// restart from scratch
			this.log('rebuilding index', this.name, 'Source version', Source.startVersion, 'index version')
			// first cancel any existing indexing
			this.clearAllData()
		}

		static reset() {
			this.rebuildIndex()
			return this.resumeIndex()
		}


		static log(...args) {
			this.eventLog.push(args.join(' ') + ' ' + new Date().toLocaleString())
			console.log(...args)
		}
		static warn(...args) {
			this.eventLog.push(args.join(' ') + ' ' + new Date().toLocaleString())
			console.warn(...args)
		}
		static async resumeIndex() {
			// TODO: if it is over half the index, just rebuild
			this.state = 'initializing'
			const db: Database = this.db
			sourceVersions[Source.name] = lastIndexedVersion
			
			let idsAndVersionsToInitialize
			if (lastIndexedVersion == 1) {
				let idsAndVersionsToReindex = await Source.getInstanceIdsAndVersionsSince(lastIndexedVersion)
				this.log('Starting index from scratch ' + this.name + ' with ' + idsAndVersionsToReindex.length + ' to index')
				this.state = 'clearing'
				this.clearAllData()
				if (idsAndVersionsToReindex.length > 0)
					this.db.putSync(INITIALIZING_LAST_KEY, Buffer.from([1, 255]))
				this.updateDBVersion()
				this.log('Cleared index', this.name)
				idsAndVersionsToInitialize = idsAndVersionsToReindex
				idsAndVersionsToReindex = []
			} else {
				let resumeFromKey = this.db.get(INITIALIZING_LAST_KEY)
				if (resumeFromKey) {
					//await clearEntries(Buffer.from([2]), (sourceId) => sourceId > resumeFromKey)
					this.log(this.name + ' Resuming from key ' + fromBufferKey(resumeFromKey))
					idsAndVersionsToInitialize = Source.getIdsAndVersionFromKey(resumeFromKey)
				}
			}
			this.initializing = false
			let min = Infinity
			let max = 0
			if (idsAndVersionsToInitialize && idsAndVersionsToInitialize.length > 0) {
				this.isInitialBuild = true
				this.queue = new IteratorThenMap(idsAndVersionsToInitialize.map(({id, version}) =>
					[id, new InitializingIndexRequest(version)]), idsAndVersionsToInitialize.length, this.queue)
				this.state = 'building'
				this.log('Created queue for initial index build', this.name)
				await this.requestProcessing(DEFAULT_INDEXING_DELAY)
				this.log('Finished initial index build of', this.name, 'with', idsAndVersionsToInitialize.length, 'entries')
				this.queue.isReplaced = true
				this.queue = this.queue.deferredMap || new Map()
				this.queue.isReplaced = false
				this.isInitialBuild = false
				await db.remove(INITIALIZING_LAST_KEY)
			}
			this.state = 'ready'
			return
			function clearEntries(start, condition) {
				let result
				db.getRange({
					start
				}).forEach(({ key, value }) => {
					try {
						let [, sourceId] = fromBufferKey(key, true)
						if (condition(sourceId)) {
							result = db.remove(key)
						}
					} catch(error) {
						console.error(error)
					}
				})
				return result // just need to wait for last one to finish (guarantees all others are finished)
			}
		}

		static delay(ms) {
			return new Promise(resolve => setTimeout(resolve, ms))
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
			return when(Source.whenUpdatedInContext(true), () => {
				let keyPrefix = toBufferKey(id)
				let iterable = this._getIndexedValues({
					start: Buffer.concat([keyPrefix, SEPARATOR_BYTE]), // the range of everything starting with id-
					end: Buffer.concat([keyPrefix, SEPARATOR_NEXT_BYTE]),
				})
				return this.returnsIterables ? iterable : iterable.asArray
			})
		}

		static getIndexedKeys(id) {
			let keyPrefix = toBufferKey(id)
			return this._getIndexedValues({
				start: Buffer.concat([keyPrefix, SEPARATOR_BYTE]), // the range of everything starting with id-
				end: Buffer.concat([keyPrefix, SEPARATOR_NEXT_BYTE]),
				values: false,
			}, true).map(({ key, value }) => key)
		}

		static parseEntryValue(buffer) {
			let statusByte = buffer[0]
			if (statusByte >= COMPRESSED_STATUS_24) {
				buffer = this.uncompressEntry(buffer, statusByte, 0)
			}
			return parseLazy(buffer, { shared: this.sharedStructure })
		}
		static getIndexedValues(range: IterableOptions) {
			range = range || {}
			if (!this.initialized && range.waitForInitialization) {
				return this.start().then(() => this.getIndexedValues(range))
			}
			if (range.start !== undefined)
				range.start = toBufferKey(range.start)
			else
				range.start = Buffer.from([2])
			if (range.end !== undefined)
				range.end = toBufferKey(range.end)
			return when(!range.noWait && this.whenUpdatedInContext(), () =>
				this._getIndexedValues(range, !range.onlyValues))
		}

		// Get a range of indexed entries for this id (used by Reduced)
		static _getIndexedValues(range: IterableOptions, returnFullKeyValue?: boolean) {
			const db: Database = this.db
			let approximateSize = 0
			let promises = []
			return db.getRange(range).map(({ key, value }) => {
				let [, sourceId] = fromBufferKey(key, true)
				/*if (range.recordApproximateSize) {
					let approximateSize = approximateSize += key.length + (value && value.length || 10)
				}*/
				let parsedValue = value !== null ? value.length > 0 ? this.parseEntryValue(value) : Source.get(sourceId) : value
				if (parsedValue && parsedValue.then) {
					return parsedValue.then(parsedValue => returnFullKeyValue ? {
						key: sourceId,
						value: parsedValue,
					} : parsedValue)
				}
				return returnFullKeyValue ? {
					key: sourceId,
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
		static resetAll() {
			// rebuild index
			this.log('Index', this.name, 'resetAll')
			return this.rebuildIndex()
		}

		static whenUpdatedInContext(context?) {
			return Source.whenUpdatedInContext(true)
				/*if (context)
					context.setVersion(lastIndexedVersion)*/
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
			return Source.openChildDB(this, true)
		}
		static initialize(module) {
			this.initializing = true
			this.Sources[0].start()
			/*if (this.Sources[0].updatingProcessModule && !this.updatingProcessModule) {
				this.updatingProcessModule = this.Sources[0].updatingProcessModule
			}*/
			allIndices.push(this)
			return when(super.initialize(module), () => {
				this.initializing = false
			})
		}
		static initializeData() {
			return when(super.initializeData(), () => {
				return this.resumeIndex()
			})
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
			let options: IterableOptions = {
				start: Buffer.from([2]),
				values: false
			}
			if (range) {
				if (range.start != null)
					options.start = toBufferKey(range.start)
				if (range.end != null)
					options.end = toBufferKey(range.end)
			}
			let lastKey
			return when(this.whenProcessingComplete, () =>
				db.getRange(options).map(({ key }) => fromBufferKey(key, true)[0]).filter(key => {
					if (key !== lastKey) { // skip multiple entries under one key
						lastKey = key
						return true
					}
				}).asArray)
		}
	}
}
Index.from = (Source) => Index({ Source })
Index.getCurrentStatus = () => {
	function estimateSize(size, previousState) {
		return (previousState ? JSON.stringify(previousState).length : 1) + size
	}
	return allIndices.map(Index => ({
		name: Index.name,
		//queued: Index.queue.size,
		state: Index.state,
		concurrencyLevel: Index.averageConcurrencyLevel,
		//pendingRequests: Array.from(Index.pendingRequests),
	}))
}
const allIndices = []
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
