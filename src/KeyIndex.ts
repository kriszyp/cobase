import { spawn, currentContext, VArray, ReplacedEvent, UpdateEvent } from 'alkali'
import { serialize, parse } from 'dpack'
import { Persistable } from './Persisted'
import { toBufferKey, fromBufferKey } from 'ordered-binary'
import when from './util/when'
import ExpirationStrategy from './ExpirationStrategy'
import { OperationsArray, IterableOptions, Database } from './storage/Database'
import { DEFAULT_CONTEXT } from './RequestContext'
//import { mergeProgress, registerProcessing, whenClassIsReady, DEFAULT_CONTEXT } from './UpdateProgress'

const expirationStrategy = ExpirationStrategy.defaultInstance
const DEFAULT_INDEXING_CONCURRENCY = 15
const SEPARATOR_BYTE = Buffer.from([30]) // record separator control character
const SEPARATOR_NEXT_BYTE = Buffer.from([31])
const LAST_INDEXED_VERSION_KEY = Buffer.from([1, 2])
const INDEXING_STATE = Buffer.from([1, 3])
const EMPTY_BUFFER = Buffer.from([])
const INDEXING_MODE = { indexing: true }
const DEFAULT_INDEXING_DELAY = 120
const INITIALIZATION_SOURCE = 'is-initializing'

export interface IndexRequest {
	previousState?: any
	previousVersion?: number
	pendingProcesses?: number[]
	deleted?: boolean
	sources?: Set<any>
	version: number
	triggers?: Set<any>
}
interface IndexEntryUpdate {
	sources: Set<any>
	triggers?: Set<any>
}
export const Index = ({ Source }) => {
	Source.updateWithPrevious = true
	let operations: OperationsArray = []
	let lastIndexedVersion = 0
	let updatedIndexEntries = new Map<any, IndexEntryUpdate>()
	const sourceVersions = {}
	const processingSourceVersions = new Map<String, number>()
	const tentativeEntityOperations = new Map<number, {}>()
	const waitingForEntityToBeIndexedInpendingProcess = []
	let pendingProcesses = new Map<number, number>()
	function addUpdatedIndexEntry(key, sources, triggers) {
		let entry = updatedIndexEntries.get(key)
		if (!entry) {
			updatedIndexEntries.set(key, entry = {
				sources: new Set(),
				triggers: new Set(),
			})
		}
		if (sources)
			for (let source of sources)
				entry.sources.add(source)
		if (triggers)
			for (let trigger of triggers)
				entry.triggers.add(trigger)
	}

	return class extends Persistable.as(VArray) {
		version: number
		static Sources = [Source]
		static whenProcessingComplete: Promise<any> // promise for the completion of processing in current indexing task for this index
		static whenCommitted: Promise<any> // promise for when an update received by this index has been fully committed (to disk)
		static get whenFullyReadable(): Promise<any> {
			return this._whenFullyReadable
		} // promise for when the results of the current indexing task are fully readable (all downstream indices have updated based on the updates in this index)
		static set whenFullyReadable(whenReadable) {
			this._whenFullyReadable = whenReadable
		}
		static indexingProcess: Promise<any>

		static *indexEntry(id, indexRequest: IndexRequest) {
			let { previousState, deleted, sources, triggers, version, hasConcurrency } = indexRequest
			try {
				let toRemove = new Map()
				// TODO: handle delta, for optimized index updaes
				// this is for recording changed entities and removing the values that previously had been indexed
				let previousEntries
				let entity = Source.for(id)
				try {
					if (previousState && previousState.then) {
						previousState = yield previousState
					}
					if (previousState !== undefined) { // if no data, then presumably no references to clear
						// use the same mapping function to determine values to remove
						previousEntries = yield this.indexBy(previousState, id)
						if (typeof previousEntries == 'object') {
							if (!(previousEntries instanceof Array)) {
								previousEntries = [previousEntries]
							}
							for (let entry of previousEntries) {
								let previousValue = entry.value
								previousValue = previousValue === undefined ? EMPTY_BUFFER : serialize(previousValue)
								toRemove.set(typeof entry === 'object' ? entry.key : entry, previousValue)
							}
						} else if (previousEntries != undefined) {
							toRemove.set(previousEntries, EMPTY_BUFFER)
						}
					}
				} catch(error) {
					if (indexRequest.version !== version) return // don't log errors from invalidated states
					console.warn('Error indexing previous value', Source.name, 'for', this.name, id, error)
				}
				if (indexRequest.version !== version) return // if at any point it is invalidated, break out
				let entries
				const operations = []
				if (!deleted) {
					let attempts = 0
					let data
					try {
						data = yield entity.valueOf(INDEXING_MODE)
					} catch(error) {
						try {
							// try again
							data = yield entity.valueOf(INDEXING_MODE)
						} catch(error) {
							if (indexRequest.version !== version) return // if at any point it is invalidated, break out
							console.warn('Error retrieving value needing to be indexed', error, 'for', this.name, entity && entity.id)
						}
					}
					if (indexRequest.version !== version) return // if at any point it is invalidated, break out
					// let the indexBy define how we get the set of values to index
					try {
						entries = data === undefined ? data : yield this.indexBy(data, id)
					} catch(error) {
						if (indexRequest.version !== version) return // if at any point it is invalidated, break out
						console.warn('Error indexing value', error, 'for', this.name, id)
					}
					if (typeof entries != 'object' || !(entries instanceof Array)) {
						// allow single primitive key
						entries = entries === undefined ? [] : [entries]
					}
					for (let entry of entries) {
						// we use the composite key, so we can quickly traverse all the entries under a certain key
						let key = typeof entry === 'object' ? entry.key : entry // TODO: Maybe at some point we support dates as keys
						// TODO: If toRemove has the key, that means the key exists, and we don't need to do anything, as long as the value matches (if there is no value might be a reasonable check)
						let removedValue = toRemove.get(key)
						// a value of '' is treated as a reference to the source object, so should always be treated as a change
						let value = entry.value === undefined ? EMPTY_BUFFER : serialize(entry.value)
						if (removedValue !== undefined)
							toRemove.delete(key)
						let isChanged = removedValue === undefined || !value.equals(removedValue)
						if (isChanged || value.length === 0) {
							if (isChanged) {
								let fullKey = Buffer.concat([toBufferKey(key), SEPARATOR_BYTE, toBufferKey(id)])
								operations.push({
									type: 'put',
									key: fullKey,
									value: value
								})
								operations.byteCount = (operations.byteCount || 0) + value.length + fullKey.length
							}
							addUpdatedIndexEntry(key, sources, triggers)
						}
					}
				}
				for (let [key] of toRemove) {
					operations.push({
						type: 'del',
						key: Buffer.concat([toBufferKey(key), SEPARATOR_BYTE, toBufferKey(id)])
					})
					addUpdatedIndexEntry(key, sources, triggers)
				}
				if (Index.onIndexEntry) {
					Index.onIndexEntry(this.name, id, previousEntries, entries)
				}
				if (indexRequest.version) {
			//		console.log('indexRequest.version', indexRequest.version)
					lastIndexedVersion = Math.max(indexRequest.version, lastIndexedVersion)
				}
				else
					console.warn('index request missing version', this.name, id)
			} catch(error) {
				if (indexRequest.version !== version) return // if at any point it is invalidated, break out, don't log errors from invalidated states
				console.warn('Error indexing', Source.name, 'for', this.name, id, error)
			}
			this.db.batch(operations)
			this.sendUpdates()
			this.queue.delete(id)
			if (indexRequest.resolveOnCompletion) {
				for (const resolve of indexRequest.resolveOnCompletion) {
					resolve()
				}
			}
		}

		static *rebuildIndex() {
			this.rebuilt = true
			// restart from scratch
			console.info('rebuilding index', this.name, 'Source version', Source.startVersion, 'index version')
			// first cancel any existing indexing
			yield this.db.clear()
			yield this.db.put(LAST_INDEXED_VERSION_KEY, Buffer.from('0')) // indicates indexing has started
		}

		static queue = new Map<any, IndexRequest>()
		static *processQueue() {
			this.state = 'processing'
			if (this.onStateChange) {
				this.onStateChange({ processing: true, started: true })
			}
			let cpuUsage = process.cpuUsage()
			let cpuTotalUsage = cpuUsage.user + cpuUsage.system
			let cpuAdjustment = 2
			try {
				let queue = this.queue
				let initialQueueSize = queue.size
				currentlyProcessing.add(this)
				if (initialQueueSize > 100) {
					console.log('Indexing', initialQueueSize, Source.name, 'for', this.name)
				}
				let indexingInProgress = []
				let sinceLastStateUpdate = 0
				do {
					if (this.nice > 0)
						yield this.delay(this.nice) // short delay for other processing to occur
					for (let [id, indexRequest] of queue) {
						// check for concurrent processes
						if (indexRequest.pendingProcesses && pendingProcesses) {
							let pendingRequests = []
							for (const pid of indexRequest.pendingProcesses) {
								// check to see if the version could be in conflict
								let pendingProcessVersion = pendingProcesses.get(pid)
								if (pendingProcessVersion > indexRequest.previousVersion && pendingProcessVersion < indexRequest.version) {
									pendingRequests.push(indexRequest.pendingProcesses.map(pendingProcess => this.sendRequestToIndex(pendingProcess, indexRequest)))
								}
							}
							if (pendingRequests.length > 0) {
								indexingInProgress.push(Promise.all(indexRequest.pendingProcesses.map(pendingProcess => this.sendRequestToIndex(pendingProcess, indexRequest))).then(results => {
									if (results.some(({ processedRemotely }) => processedRemotely)) {
										this.queue.delete(id)
									} else {
										sinceLastStateUpdate++
										return this.indexEntry(id, indexRequest)
									}
								}))
							} else { // no other processes that are processing a version that could be conflicting
								sinceLastStateUpdate++
								indexingInProgress.push(spawn(this.indexEntry(id, indexRequest)))
							}
						} else {
							sinceLastStateUpdate++
							indexingInProgress.push(spawn(this.indexEntry(id, indexRequest)))
						}

						if (sinceLastStateUpdate > (Source.MAX_CONCURRENCY || DEFAULT_INDEXING_CONCURRENCY) * cpuAdjustment) {
							// we have process enough, commit our changes so far
							this.onBeforeCommit && this.onBeforeCommit(id)
							yield Promise.all(indexingInProgress)
							let processedEntries = indexingInProgress.length
							sinceLastStateUpdate = 0
							indexingInProgress = []
							this.saveLatestVersion()
							cpuUsage = process.cpuUsage()
							let lastCpuUsage = cpuTotalUsage
							cpuTotalUsage = cpuUsage.user + cpuUsage.system
							cpuAdjustment = (cpuAdjustment + 40000 / (cpuTotalUsage - lastCpuUsage + 10000)) / 2
							/* Can be used to measure performance
							let [seconds, billionths] = process.hrtime(lastStart)
							lastStart = process.hrtime()
							if (Math.random() > 0.95)
								console.log('processed', processedEntries, 'for', this.name, 'in', seconds + billionths/1000000000, 'secs, waiting', this.nice/ 1000) */
							if (this.nice > 0)
								yield this.delay(this.nice) // short delay for other processing to occur
						}

						if (this.cancelIndexing) {
							console.info('Canceling current indexing process')
							// if we suddenly need to rebuild...
							return
						}
					}
					yield Promise.all(indexingInProgress)
					this.saveLatestVersion()
				} while (queue.size > 0)
				this.finishAsIndexer()
				// TODO: Wait for tentative values to be dismissed
				if (initialQueueSize > 100) {
					console.log('Finished indexing', initialQueueSize, Source.name, 'for', this.name)
				}
			} catch (error) {
				console.error('Error occurred in processing index queue for', this.name, error, 'remaining in queue', this.queue.size)
			}
			this.state = 'processed'
			if (this.onStateChange) {
				this.onStateChange({ processing: true, started: false })
			}
		}

		static finishAsIndexer() {
			const db = this.db
			return db.transaction(() => {
				const indexingState = parse(db.get(INDEXING_STATE)) || {}
				if (!indexingState.processes)
					indexingState.processes = new Map()
				indexingState.processes.delete(process.pid)
				if (indexingState.processes.size == 0) {
					indexingState.version = lastIndexedVersion
				}

				if (!serialize(indexingState).toString().match(/Map/))
					debugger
				db.put(INDEXING_STATE, serialize(indexingState))
				this.isRegisteredAsIndexing = false // no longer indexing
			})
		}

		static *resumeIndex() {
			// TODO: if it is over half the index, just rebuild
			lastIndexedVersion = +this.db.getSync(LAST_INDEXED_VERSION_KEY) || 0
			sourceVersions[Source.name] = lastIndexedVersion
			const idsAndVersionsToReindex = yield Source.getInstanceIdsAndVersionsSince(lastIndexedVersion)
			let min = Infinity
			let max = 0
			for (let { id, version } of idsAndVersionsToReindex) {
				min = Math.min(version, min)
				max = Math.max(version, max)
			}
			//console.log('getInstanceIdsAndVersionsSince for index', this.name, idsAndVersionsToReindex.length, min, max)
			const setOfIds = new Set(idsAndVersionsToReindex.map(({ id }) => id))

			const db: Database = this.db
			if (lastIndexedVersion == 0 || idsAndVersionsToReindex.isFullReset) {
				yield this.db.clear()
				this.updateDBVersion()
			} else if (idsAndVersionsToReindex.length > 0) {
				console.info('Resuming from ', lastIndexedVersion, 'indexing', idsAndVersionsToReindex.length, this.name)
				yield db.iterable({
					start: Buffer.from([2])
				}).map(({ key, value }) => {
					let [, sourceId] = fromBufferKey(key, true)
					if (setOfIds.has(sourceId)) {
						db.removeSync(key)
					}
				}).asArray
			} else {
				return
			}
			for (let { id, version } of idsAndVersionsToReindex) {
				if (!version)
					console.log('resuming without version',this.name, id)
				this.queue.set(id, {
					version,
					triggers: new Set([INITIALIZATION_SOURCE])
				})
			}
			yield this.requestProcessing(DEFAULT_INDEXING_DELAY)
		}

		static delay(ms) {
			return new Promise(resolve => setTimeout(resolve, ms))
		}
		static saveLatestVersion() {
			let indexedProgress = lastIndexedVersion
			let nextIndexRequest = this.queue[0]
			if (nextIndexRequest) {
				// if there is an index request in the queue with an earlier version, make our last version right before that.
				indexedProgress = Math.min(nextIndexRequest.version - 1, lastIndexedVersion)
			}
			const indexingState = parse(this.db.get(INDEXING_STATE)) || {}
			if (!indexingState.processes) {
				indexingState.processes = new Map()
			}
			indexingState.processes.set(process.pid, indexedProgress)
		}

		static sendUpdates() {
			let updatedIndexEntriesArray = Array.from(updatedIndexEntries).reverse()
			updatedIndexEntries = new Map()
			let indexedEntry
			while ((indexedEntry = updatedIndexEntriesArray.pop())) {
				try {
					let event = new ReplacedEvent()
					let indexEntryUpdate: IndexEntryUpdate = indexedEntry[1]
					event.sources = indexEntryUpdate.sources
					event.triggers = indexEntryUpdate.triggers
					this.for(indexedEntry[0]).updated(event)
				} catch (error) {
					console.error('Error sending index updates', error)
				}
			}
		}

		transform() {
			let keyPrefix = toBufferKey(this.id)
			let iterable = this.getIndexedValues({
				start: Buffer.concat([keyPrefix, SEPARATOR_BYTE]), // the range of everything starting with id-
				end: Buffer.concat([keyPrefix, SEPARATOR_NEXT_BYTE]),
				recordApproximateSize: true,
			})
			return this.constructor.returnsAsyncIterables ? iterable : iterable.asArray
		}

		getIndexedKeys() {
			let keyPrefix = toBufferKey(this.id)
			return this.getIndexedValues({
				start: Buffer.concat([keyPrefix, SEPARATOR_BYTE]), // the range of everything starting with id-
				end: Buffer.concat([keyPrefix, SEPARATOR_NEXT_BYTE]),
				values: false,
			}, true).map(({ key, value }) => key)
		}

		// Get a range of indexed entries for this id (used by Reduced)
		getIndexedValues(range: IterableOptions, returnFullKeyValue?: boolean) {
			const db: Database = this.constructor.db
			let approximateSize = 0
			return db.iterable(range).map(({ key, value }) => {
				let [, sourceId] = fromBufferKey(key, true)
				if (range.recordApproximateSize) {
					this.approximateSize = approximateSize += key.length + (value && value.length || 10)
				}
				return returnFullKeyValue ? {
					key: sourceId,
					value: value !== null ? value.length > 0 ? parse(value) : Source.for(sourceId) : value,
				} : value.length > 0 ? parse(value) : Source.for(sourceId)
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
			console.log('Index', this.name, 'resetAll')
			return Promise.resolve(spawn(this.rebuildIndex())).then(() => spawn(this.resumeIndex()))
		}

		static whenUpdatedInContext(context) {
			context = context || currentContext
			let updateContext = (context && context.expectedVersions) ? context : DEFAULT_CONTEXT
			return when(Source.whenUpdatedInContext(), () => {
				// Go through the expected source versions and see if we are behind and awaiting processing on any sources
				for (const sourceName in updateContext.expectedVersions) {
					// if the expected version is behind, wait for processing to finish
					if (updateContext.expectedVersions[sourceName] > sourceVersions[sourceName])
						return this.requestProcessing(0) // up the priority
				}
			})
		}

		// static returnsAsyncIterables = true // maybe at some point default this to on

		static getInstanceIdsAndVersionsSince(version) {
			// no version tracking with indices
			return Promise.resolve([])
		}

		clearCache() {
			this.cachedValue = undefined
			this.cachedVersion = -1
		}

		getValue() {
			// First: ensure that all the source instances are up-to-date
			const context = currentContext
			return when(this.constructor.whenUpdatedInContext(context), () => {
				if (context)
						context.setVersion(this.constructor.version)
				return when(super.getValue(), (value) => {
					expirationStrategy.useEntry(this, (this.approximateSize || 100) * 10) // multiply by 10 because generally we want to expire index values pretty quickly
					return value
				})
			})
		}

		static initialize(module) {
			this.Sources[0].start()
			/*if (this.Sources[0].updatingProcessModule && !this.updatingProcessModule) {
				this.updatingProcessModule = this.Sources[0].updatingProcessModule
			}*/
			allIndices.push(this)
			return when(super.initialize(module), () => {
				if (this.doesInitialization !== false) {
					return spawn(this.resumeIndex())
				}
			})
		}
		static isRegisteredAsIndexing = false // has a lock as the the current indexing process
		static isConcurrentlyIndexing = false // are we concurrently processing, writing update version as we get them into the version map
		static whenAllConcurrentlyIndexing?: Promise<any> // promise if we are waiting for the initial indexing process to join the concurrent indexing mode
		static checkAndUpdateProcessMap() {
			const db = this.db
			return db.transaction(() => {
				const indexingState = parse(db.get(INDEXING_STATE)) || {}

				pendingProcesses = null
				if (!indexingState.processes) {
					indexingState.processes = new Map()
				} else if (indexingState.processes.size) {
					pendingProcesses = indexingState.processes
				}
				indexingState.processes.set(process.pid, lastIndexedVersion)

				// otherwise this should be added to our queue, and processed when it is our turn
				// we record waiting processes so the main process doesn't record a version update beyond the version of this process
				db.put(INDEXING_STATE, serialize(indexingState))
				// once saved, don't include ourselves in the "other" processes
				if (pendingProcesses) {
					pendingProcesses.delete(process.pid)
				}
				this.isRegisteredAsIndexing = true
				return pendingProcesses
			})
		}
		static sendRequestToIndex(pid, indexRequest) {
			return this.sendRequestToProcess(pid, {
				id: indexRequest.id,
				version: indexRequest.version,
				previousVersion: indexRequest.previousVersion,
			})
		}
		static receiveRequest({ id, version, previousVersion }) {
			const updateInQueue = this.queue.get(id)
			if (updateInQueue) {
				if (updateInQueue.previousVersion < previousVersion) {
					// we have an earlier starting point, keep ours
					if (updateInQueue.version < version) {
						// TODO: Update our entity?
					}
					return new Promise(resolve =>
						(updateInQueue.resolveOnCompletion || (updateInQueue.resolveOnCompletion = [])).push([resolve]))
						.then(() => ({ remotelyIndexed: true })) // reply when we have finished indexing this
				}
			}
			return {
				remotelyIndexed: false
			}
			// else return/reply that the indexing can go ahead, no conflicts here
		}
		static updated(event, by) {
			// we don't propagate immediately through the index, as the indexing must take place
			// to determine the affecting index entries, and the indexing will send out the updates
			if (event.type === 'indexing-completion') {
				for (const sourceName in event.sourceVersions) {
					processingSourceVersions[sourceName] = event.sourceVersions[sourceName]
				}
				return event
			}
			if (event.type === 'process-identification') {
				this.otherProcesses.push(event.pid)
				return // shouldn't propagate
			}
			if (this.otherProcesses && this.otherProcesses.includes(event.sourceProcess)) {
				// just skip these
				return event
			}
			let context = currentContext
			let updateContext = (context && context.expectedVersions) ? context : DEFAULT_CONTEXT

			this.updateVersion()
			let previousEntry = event.previousValues && event.previousValues.get(by)
			let id = by && by.constructor == this.Sources[0] && by.id // if we are getting an update from a source instance
			if (id && !this.gettingAllIds) {
				this.checkAndUpdateProcessMap()
				let whenPermittedBypendingProcesses

				if (event.noPreviousValue) {
					// this should mean that the entity was also updated in another process, and we don't have the previous state, so we need to let that process index it
					waitingForEntityToBeIndexedInpendingProcess.push(id)
					return true
				}
				// queue up processing the event
				let indexRequest = this.queue.get(id)
				if (indexRequest) {
					// put it at that end so version numbers are in order
					this.queue.delete(id)
					this.queue.set(id, indexRequest)
					indexRequest.version = event.version
					if (event.triggers)
						for (let trigger of event.triggers)
							indexRequest.triggers.add(trigger)
				} else {
					this.queue.set(id, indexRequest = {
						previousState: previousEntry && previousEntry.data,
						previousVersion: previousEntry ? previousEntry.version : 0,
						version: event.version,
						triggers: event.triggers instanceof Set ? event.triggers : new Set(event.triggers),
					})
					this.requestProcessing(DEFAULT_INDEXING_DELAY)
				}
				if (pendingProcesses) {
					for (const [pid, version] of pendingProcesses) {
						if (version < event.version && version > (event.previousVersion || 0))
							(indexRequest.pendingProcesses || (indexRequest.pendingProcesses = [])).push(pid)
					}
				}
				if (!indexRequest.version) {
					throw new Error('missing version')
				}
				indexRequest.deleted = event.type == 'deleted'
				if (event.sources) {
					if (!indexRequest.sources) {
						indexRequest.sources = new Set()
					}
					for (let source of event.sources) {
						indexRequest.sources.add(source)
					}
				} else if (event.source) {
					if (!indexRequest.sources) {
						indexRequest.sources = new Set()
					}
					indexRequest.sources.add(event.source)
				}

				//registerProcessing(updateContext, this, this.whenFullyReadable)
				//registerProcessing(event, this, this.whenFullyReadable)
			}
			if (event && event.type == 'reset') {
				return super.updated(event, by)
			}
			return event
		}

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
		static nice = DEFAULT_INDEXING_DELAY
		static requestProcessing(nice) {
			// Indexing is performed one index at a time, until the indexing on that index is completed.
			// This is to prevent too much processing being consumed by the index processing,
			// and to allow dependent indices to fully complete before downstream indices start to
			// avoid thrashing from repeated changes in values
			if (this.whenProcessingComplete) {
				// TODO: priority increases need to be transitively applied
				this.nice = Math.min(this.nice, nice) // once started, niceness can only go down (and priority up)
			} else {
				this.nice = nice
				let whenUpdatesReadable
				this.state = 'pending'
				this.whenProcessingComplete = Promise.all(this.Sources.map(Source =>
					Source.whenProcessingComplete)).then(() =>
					spawn(this.processQueue())).then(() => {
						this.state = 'ready'
						this.whenProcessingComplete = null
						currentlyProcessing.delete(this)
						for (const sourceName in processingSourceVersions) {
							sourceVersions[sourceName] = processingSourceVersions[sourceName]
						}
						const event = new IndexingCompletionEvent()
						event.sourceVersions = sourceVersions
						event.sourceVersions[this.name] = lastIndexedVersion
						super.updated(event, this)
					})
				this.whenProcessingComplete.version = this.version
				this.whenFullyReadable = this.whenCommitted =
					this.whenProcessingComplete.then(() => this)
			}
			return this.whenProcessingComplete
		}


		static getInstanceIds(range: IterableOptions) {
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
				db.iterable(options).map(({ key }) => fromBufferKey(key, true)[0]).filter(key => {
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
		queued: Index.queue.size,
		state: Index.state
	}))
}
const allIndices = []
export default Index

let currentlyProcessing = new Set()

class IndexingCompletionEvent extends UpdateEvent {
	type = 'indexing-completion'
}
