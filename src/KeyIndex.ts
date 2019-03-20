import { spawn, currentContext, VArray, ReplacedEvent, UpdateEvent, getNextVersion } from 'alkali'
import { serialize, parse } from 'dpack'
import { Persistable, INVALIDATED_ENTRY } from './Persisted'
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
const INDEXING_STATE = Buffer.from([1, 5]) // a metadata key in the range the should be cleared on database clear
const EMPTY_BUFFER = Buffer.from([])
const INDEXING_MODE = { indexing: true }
const DEFAULT_INDEXING_DELAY = 60
const INITIALIZATION_SOURCE = 'is-initializing'
const INDEXING_STATE_SIZE = 3584 // good size for ensuring that it is an (and only one) overflow page in LMDB, and won't be moved
const INITIALIZATION_SOURCE_SET = new Set([INITIALIZATION_SOURCE])
export interface IndexRequest {
	previousEntry?: any
	pendingProcesses?: number[]
	deleted?: boolean
	sources?: Set<any>
	version: number
	triggers?: Set<any>
	previousValues?: Map
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
		static Sources = [Source]
		static whenProcessingComplete: Promise<any> // promise for the completion of processing in current indexing task for this index
		static whenCommitted: Promise<any> // promise for when an update received by this index has been fully committed (to disk)
		static indexingProcess: Promise<any>

		static *indexEntry(id, indexRequest: IndexRequest) {
			let { previousEntry, deleted, sources, triggers, version } = indexRequest
			let operations: OperationsArray = []
			previousEntry = yield previousEntry
			let previousState = previousEntry && previousEntry.data
			let previousVersion = previousEntry && previousEntry.version
			let eventUpdateSources = []
			try {
				let toRemove = new Map()
				// TODO: handle delta, for optimized index updaes
				// this is for recording changed entities and removing the values that previously had been indexed
				let previousEntries
				let entity = Source.for(id)
				try {
					if (previousState === INVALIDATED_ENTRY) {
						this.queue.delete(id)
						return this.sendRequestToIndex()
/*						// this is one of the trickiest conditions in multi-process indexing. This generally means that there was an update
						// event that occurred on entity that was already updated in another process, but that other process had not resolved
						// the update yet. After we send the indexing request to the other processes, if any concurrently indexing process
						// responds, it should mean that it has finished resolving and we can make another attempat at retrieving the previous state
						// so we can properly sequence the indexing operations
						let previousEntity = indexRequest.previousValues.get(indexRequest.by) // see if another index has updated this
						previousState = previousEntity.data
						if (previousState  === INVALIDATED_ENTRY) {

							previousEntity = entity.loadLocalData()

							previousState = previousEntity.data
							indexRequest.previousValues.set(indexRequest.by, previousEntity)
							if (previousState === INVALIDATED_ENTRY) {
								// TODO: if it is still invalidated, that may mean that another process snuck in another update. we may want to try requesting previous state again.
								// But generally this is because an previous indexing process died, leaving invalidated entries in place.
								previousState = undefined
								console.warn('Indexing with previously invalidated state, re-retrieval failed', {
									id,
									name: this.name,
									status: indexRequest.status,
									source: Source.name,
									previousVersion: versionToDate(indexRequest.previousVersion),
									updatedPreviousVersion: versionToDate(previousEntity.version),
									version: versionToDate(indexRequest.version),
									now: new Date().toLocaleString(),
								})
							}
							indexRequest.previousVersion = previousEntity.version
						}*/
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
					yield entity.whenValueCommitted
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
						if (isChanged || value.length === 0 || this.alwaysUpdate) {
							if (isChanged) {
								let fullKey = Buffer.concat([toBufferKey(key), SEPARATOR_BYTE, toBufferKey(id)])
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
						key: Buffer.concat([toBufferKey(key), SEPARATOR_BYTE, toBufferKey(id)])
					})
					eventUpdateSources.push({ key, sources, triggers })
				}
				if (Index.onIndexEntry) {
					Index.onIndexEntry(this.name, id, previousEntries, entries)
				}
			} catch(error) {
				if (indexRequest.version !== version) return // if at any point it is invalidated, break out, don't log errors from invalidated states
				console.warn('Error indexing', Source.name, 'for', this.name, id, error)
			}
			this.queue.delete(id)
			const sourceWhenWritten = Source.whenWritten
			if (operations.length > 0 || eventUpdateSources.length > 0) { // note that it is possible for zero index changes to occur, but the data to still change, when using references
				yield this.submitWrites(operations, previousVersion || 0, version, eventUpdateSources)
			}
			if (indexRequest.resolveOnCompletion) {
				if (sourceWhenWritten) {
					yield sourceWhenWritten.committed
				}
				for (const resolve of indexRequest.resolveOnCompletion) {
					resolve()
				}
			}
		}
		static pendingVersions = new Map()
		static pendingEvents = new Map()

		static updateEarliestPendingVersion() {
			const processes = indexingState[1]
			for (let i = 1; i < processes + 1; i++) {
				let offset = i * 16
				let processVersion
				let pid
				if (offset != stateOffset && (processVersion = readUInt(indexingState, offset + 8)) !== 0 && (pid = readUInt(indexingState, offset)) !== 0) {
					if (processVersion < this.earliestPendingVersionInOtherProcesses || processVersion === this.earliestPendingVersionInOtherProcesses && pid < process.pid) {
						this.earliestPendingVersionInOtherProcesses = processVersion
					}
				}
			}
		}
		static submitWrites(operations, previousVersion, version, updateEventSources) {
			let committed
			if (previousVersion < this.earliestPendingVersionInOtherProcesses) {
				// previous version is earlier than all writes, proceed
				committed = this.db.batch(operations).committed
			} else {
				// first, read an updated earliestPendingVersion to see if it is still before our pending write
				this.earliestPendingVersionInOtherProcesses = (Date.now() - 1500000000000) * 256
				this.updateEarliestPendingVersion()
				if (previousVersion < this.earliestPendingVersionInOtherProcesses) {
					// now previous version is earlier than all writes from other processes, proceed
					committed = this.db.batch(operations).committed
				} else {
					if (!this.queuedWrites)
						this.queuedWrites = []
					this.queuedWrites.push({
						previousVersion,
						version,
						operations,
						updateEventSources
					})
					if (!this.queuedRequestForWriteNotification) {
						return this.queuedRequestForWriteNotification = this.sendRequestForWriteNotification().then(() => this.resumeWrites())
					}
				}
			}
			committed.maxVersion = Math.max(committed.maxVersion || 0, version)
			let pendingEvents = this.pendingEvents.get(committed)
			if (!pendingEvents) {
				this.pendingVersions.set(committed, version)
				this.pendingEvents.set(committed, pendingEvents = [])
				committed.then(() => {
					this.pendingVersions.delete(committed)
					this.pendingEvents.delete(committed)
					let myEarliestPendingVersion = 0 // recompute this
					for ([, version] of this.pendingVersions) {
						myEarliestPendingVersion = Math.min(myEarliestPendingVersion || Infinity, version)
					}
					if (myEarliestPendingVersion === 0 && this.queue.size) {
						for (let [, { version }] of this.queue) {
							myEarliestPendingVersion = Math.min(myEarliestPendingVersion || Infinity, version)
						}
					}
					this.updateProcessMap(myEarliestPendingVersion, true)
					this.earliestPendingVersionInOtherProcesses = myEarliestPendingVersion || (committed.maxVersion + 1)
					this.updateEarliestPendingVersion()

					const versionWord = Buffer.alloc(8)
					writeUInt(versionWord, this.earliestPendingVersionInOtherProcesses)
					versionWord.copy(indexingState, 8) // copy word for an atomic update
					this.sendUpdates(pendingEvents)
				})
			}
			pendingEvents.push(...updateEventSources)
			
			return committed
		}

		static resumeWrites() {
			const resumedWrites = this.queuedWrites
			this.queuedWrites = []
			for (const { operations, previousVersion, version, updateEventSources } of resumedWrites) {
				this.submitWrites(operations, previousVersion, version, updateEventSources)
			}
		}

		static rebuildIndex() {
			this.rebuilt = true
			lastIndexedVersion = 1

			// restart from scratch
			console.info('rebuilding index', this.name, 'Source version', Source.startVersion, 'index version')
			// first cancel any existing indexing
			this.clearAllData()
		}

		static reset() {
			this.rebuildIndex()
			return spawn(this.resumeIndex())
		}

		static queue = new Map<any, IndexRequest>()
		static *processQueue() {
			this.state = 'processing'
			if (this.onStateChange) {
				this.onStateChange({ processing: true, started: true })
			}
			let cpuUsage = process.cpuUsage()
			let cpuTotalUsage = cpuUsage.user + cpuUsage.system
			let speedAdjustment = 2
			try {
				let queue = this.queue
				let initialQueueSize = queue.size
				currentlyProcessing.add(this)
				if (initialQueueSize > 100) {
					console.log('Indexing', initialQueueSize, Source.name, 'for', this.name)
				}
				let indexingInProgress = []
				let actionsInProgress = []
				let sinceLastStateUpdate = 0
				do {
					if (this.nice > 0)
						yield this.delay(this.nice) // short delay for other processing to occur
					for (let [id, indexRequest] of queue) {
						sinceLastStateUpdate++
						indexingInProgress.push(spawn(this.indexEntry(id, indexRequest)))
						if (sinceLastStateUpdate > (Source.MAX_CONCURRENCY || DEFAULT_INDEXING_CONCURRENCY) * speedAdjustment) {
							// we have process enough, commit our changes so far
							this.onBeforeCommit && this.onBeforeCommit(id)
							let indexingStarted = indexingInProgress
							indexingInProgress = []
							sinceLastStateUpdate = 0
							yield Promise.all(indexingStarted)
							let processedEntries = indexingStarted.length
							//this.saveLatestVersion(false)
							cpuUsage = process.cpuUsage()
							let lastCpuUsage = cpuTotalUsage
							cpuTotalUsage = cpuUsage.user + cpuUsage.system
							// calculate an indexing adjustment based on cpu usage and queue size (which we don't want to get too big)
							speedAdjustment = (speedAdjustment + 40000 / (cpuTotalUsage - lastCpuUsage + 10000)) / 2
							/* Can be used to measure performance
							let [seconds, billionths] = process.hrtime(lastStart)
							lastStart = process.hrtime()
							if (Math.random() > 0.95)
								console.log('processed', processedEntries, 'for', this.name, 'in', seconds + billionths/1000000000, 'secs, waiting', this.nice/ 1000) */
							if (this.nice > 0)
								yield this.delay(Math.round(this.nice * 1000 / (queue.size + 1000))) // short delay for other processing to occur
						}
					}
					this.state = 'waiting on other processes'
					this.state = 'processing'
					yield Promise.all(indexingInProgress) // then wait for all indexing to finish everything
					//this.saveLatestVersion(false)
				} while (queue.size > 0)
				//this.saveLatestVersion(true)
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

		static *resumeIndex() {
			// TODO: if it is over half the index, just rebuild
			console.log('resumeIndex', this.name)
			this.state = 'initializing'
			const db: Database = this.db
			console.log('resumeIndex', this.name, 'starting from', lastIndexedVersion)
			sourceVersions[Source.name] = lastIndexedVersion
			this.queue.clear()
			let idsAndVersionsToReindex
			idsAndVersionsToReindex = yield Source.getInstanceIdsAndVersionsSince(lastIndexedVersion)
			this.initializing = false
			let min = Infinity
			let max = 0
			for (let { id, version } of idsAndVersionsToReindex) {
				min = Math.min(version, min)
				max = Math.max(version, max)
			}
			if (lastIndexedVersion == 1 || idsAndVersionsToReindex.isFullReset) {
				console.log('Starting index from scratch', this.name, 'with', idsAndVersionsToReindex.length, 'to index')
				this.state = 'clearing'
				this.clearAllData()
				this.updateDBVersion()
			} else if (idsAndVersionsToReindex.length > 0) {
				this.state = 'resuming'
				console.info('Resuming from ', lastIndexedVersion, 'indexing', idsAndVersionsToReindex.length, this.name)
				const setOfIds = new Set(idsAndVersionsToReindex.map(({ id }) => id))
				// clear out all the items that we are indexing, since we don't have their previous state
				yield db.iterable({
					start: Buffer.from([2])
				}).map(({ key, value }) => {
					let [, sourceId] = fromBufferKey(key, true)
					if (setOfIds.has(sourceId)) {
						db.removeSync(key)
					}
				}).asArray
			} else {
				this.state = 'ready'
				return
			}
			this.updateProcessMap(lastIndexedVersion)

			this.state = 'initializing queue'
			for (let { id, version } of idsAndVersionsToReindex) {
				if (!version)
					console.log('resuming without version',this.name, id)
				this.queue.set(id, new InitializingIndexRequest(version))
			}
			this.state = 'processing'
			yield this.requestProcessing(DEFAULT_INDEXING_DELAY)
		}

		static delay(ms) {
			return new Promise(resolve => setTimeout(resolve, ms))
		}
		static saveLatestVersion(finished) {
			let indexedProgress = lastIndexedVersion
			let nextIndexRequest = this.queue[0]
			if (nextIndexRequest) {
				// if there is an index request in the queue with an earlier version, make our last version right before that.
				indexedProgress = Math.min(nextIndexRequest.version - 1, lastIndexedVersion)
			}

			if (!indexingState) {
				this.getIndexingState()
			}
			const versionWord = Buffer.alloc(8)
			writeUInt(versionWord, lastIndexedVersion)
			versionWord.copy(indexingState, 8) // copy into global version too
			if (finished) {
				indexingState.fill(0, stateOffset + 8, stateOffset + 16) // clear the version number
			} else {
				versionWord.copy(indexingState, stateOffset + 8) // copy word for an atomic update
			}
		}

		static sendUpdates(eventSources) {
			let updatedIndexEntries = new Map<any, IndexEntryUpdate>()
			// aggregate them by key so as to minimize the number of events we send
			for ( const { key, triggers, sources } of eventSources) {
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
							return // don't record sources for initialization
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
					event.triggers = indexEntryUpdate.triggers
					this.for(indexedEntry[0]).updated(event)
				} catch (error) {
					console.error('Error sending index updates', error)
				}
			}
			this.instanceIds.updated()
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
			return this.rebuildIndex()
		}

		static whenUpdatedInContext(context) {
			context = context || currentContext
			let updateContext = (context && context.expectedVersions) ? context : DEFAULT_CONTEXT
			return when(Source.whenUpdatedInContext(), () => {
				// Go through the expected source versions and see if we are behind and awaiting processing on any sources
				for (const sourceName in updateContext.expectedVersions) {
					// if the expected version is behind, wait for processing to finish
					if (updateContext.expectedVersions[sourceName] > (sourceVersions[sourceName] || 0) && this.queue.size > 0)
						return this.requestProcessing(0) // up the priority
				}
			})
		}

		// static returnsAsyncIterables = true // maybe at some point default this to on

		static getInstanceIdsAndVersionsSince(version) {
			// There is no version tracking with indices.
			// however, indices always do send updates, and as long as we wait until we are ready and finished with initial indexing
			// downstream tables should have received all the updates they need to proceed
			//console.log('getInstanceIdsAndVersionsSince from KeyIndex', this.name, version)
			return this.ready.then(() => {
				//console.log('getInstanceIdsAndVersionsSince ready from KeyIndex', this.name, version)
				return []
			})
		}

		clearCache() {
			this.cachedValue = undefined
			this.cachedVersion = -1
		}

		valueOf() {
			// First: ensure that all the source instances are up-to-date
			const context = currentContext
			return when(this.constructor.whenUpdatedInContext(context), () => {
				if (context)
					context.setVersion(lastIndexedVersion)
				return when(super.valueOf(true), (value) => {
					expirationStrategy.useEntry(this, (this.approximateSize || 100) * 10) // multiply by 10 because generally we want to expire index values pretty quickly
					return value
				})
			})
		}

		static getIndexingState(onlyTry?) {
			const getOptions = {
				sharedReference(forceUnload) {
					if (forceUnload === true) {
						indexingState = null
					} else {
						return false // if it is not forced, indicate that it is always up-to-date (we never overwrite this entry)
					}
				}
			}
			indexingState = this.db.get(INDEXING_STATE, getOptions)
			if (!indexingState && !onlyTry) {
				this.initializeIndexingState()
			}
			return indexingState
		}
		static initializeIndexingState() {
			const db = this.db
			db.transaction(() => {
				this.getIndexingState(true)
				// we setup the indexing state buffer
				if (!indexingState || indexingState.length !== INDEXING_STATE_SIZE) {
					db.putSync(INDEXING_STATE, Buffer.alloc(INDEXING_STATE_SIZE))
					console.log('wrote the INDEXING_STATE', this.name)
					this.getIndexingState(true) // now get the shared reference to it again
				}
				lastIndexedVersion = readUInt(Buffer.from(indexingState.slice(8, 16))) || 1
				stateOffset = 16
				if (indexingState[1] < 20) {
					while (stateOffset < indexingState.length) {
						const processId = readUInt(indexingState, stateOffset)
						if (processId === 0) { // empty slot, grab it for this process
							writeUInt(indexingState, process.pid, stateOffset)
							indexingState[1] = Math.max(indexingState[1], stateOffset / 16)
							//console.log('Registered indexing process at offset', stateOffset, indexingState[1], process.pid)
							// directly write to buffer, don't need to do a put
							return indexingState
						}
						stateOffset += 16
					}
				}
				console.error('No free indexing process slots, need to reset indexing state table')
				indexingState.fill(0, 0, INDEXING_STATE_SIZE)
				stateOffset = 16
				writeUInt(indexingState, process.pid, stateOffset)
				indexingState[1] = 1
			})
		}
		static initializeDB() {
			let initializingProcess = super.initializeDB()
			this.initializeIndexingState()
			return initializingProcess
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
				return spawn(this.resumeIndex())
			})
		}
		static myEarliestPendingVersion = 0 // have we registered our process, and at what version
		static whenAllConcurrentlyIndexing?: Promise<any> // promise if we are waiting for the initial indexing process to join the concurrent indexing mode
		static waitForProcess: {
			runUntilVersion: number
			pid: number
		}
		static updateProcessMap(version, force?) {
			if (this.myEarliestPendingVersion === 0 || force) {
				if (!indexingState) {
					// need to re-retrieve it
					this.getIndexingState()
				}
				const versionWord = Buffer.alloc(8)
				writeUInt(versionWord, version)
				versionWord.copy(indexingState, stateOffset + 8) // copy word for an atomic update
				this.myEarliestPendingVersion = version
			}
 		}
		static pendingRequests = new Map()
		static sendRequestToIndex(pid, id, indexRequest) {
			try {
				//console.log('sendRequestToIndex', id, this.name, 'version', indexRequest.version, 'previousVersion', indexRequest.previousVersion)
				if (!this.sendRequestToProcess) {
					return { indexed: false }
				}
				const request = {
					id,
					version: indexRequest.version,
					previousVersion: indexRequest.previousVersion,
					hasPreviousState: indexRequest.previousState !== INVALIDATED_ENTRY,
				}
				this.pendingRequests.set(id + '-' + pid, {
					pid,
					request
				})
				return withTimeout(this.sendRequestToProcess(pid, request), 60000).catch(error => {
					console.warn('Error on waiting for indexed', this.name, 'from process', pid, 'index request', request, error.toString())
					return { indexed: false }
				}).finally((indexed) => {
					this.pendingRequests.delete(id + '-' + pid)
					//console.log('sendRequestToIndex finished', id, this.name, indexed)
				})
			} catch(error) {
				if (error.message.startsWith('No socket')) {
					// clean up if the process/socket is dead
					console.info('Cleaning up socket to old process', pid)
					this.removeDeadProcessEntry(pid)
					return { indexed: false }
					// TODO: resumeIndex?
				}
				throw error
			}
		}

		static removeDeadProcessEntry(pid)  {
			if (!indexingState) {
				this.getIndexingState()
			}
			const processes = indexingState[1]
			let lastProcessNumber = 0
			for (let i = 1; i < processes + 1; i++) {
				let offset = i * 16
				let slotPid
				if (slotPid = readUInt(indexingState, offset)) {
					if (offset != stateOffset && slotPid === pid) {
						indexingState.fill(0, offset, offset + 16) // clear it out by zeroing
					} else {
						lastProcessNumber = i // valid entry, increase last process index
					}
				}
			}
			indexingState[1] = lastProcessNumber // reset the number of processes since it may have decreased
		}

		static cleanupDeadProcessReference(pid, initializingProcess) {
			this.removeDeadProcessEntry(pid)
			return super.cleanupDeadProcessReference(pid, initializingProcess)
		}

		static receiveRequest({ id, version, previousVersion, hasPreviousState }) {
			return this.whenUnblockedProcessing
			const updateInQueue = this.queue.get(id);
			if (updateInQueue) {
				if ((updateInQueue.previousVersion || 0) <= previousVersion || !hasPreviousState) {
					// we have an earlier starting point, keep ours
					if (updateInQueue.version < version) {
						// update our version number to be the latest
						updateInQueue.version = version
					}
					//console.log('receiveRequest', id, this.name, 'version', version, 'previousVersion', previousVersion, 'will handle')
					return new Promise(resolve =>
						(updateInQueue.resolveOnCompletion || (updateInQueue.resolveOnCompletion = [])).push(resolve))
						.then(() => ({ indexed: true })) // reply when we have finished indexing this
				}
			}
			//console.log('receiveRequest', id, this.name, 'version', version, 'previousVersion', previousVersion, 'but not handling')

			return {
				indexed: false
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
			if (this.initializing) {
				return // ignore events while we are waiting for the upstream source to initialize data
			}
			let context = currentContext
			let updateContext = (context && context.expectedVersions) ? context : DEFAULT_CONTEXT

			let previousEntry = event.previousValues && event.previousValues.get(by)
			let id = by && (typeof by === 'object' ? (by.constructor == this.Sources[0] && by.id) : by) // if we are getting an update from a source instance
			if (this.otherProcesses && event.sourceProcess && 
				!(id && this.queue.has(id)) && // if it is in our queue, we need to update the version number in our queue
				(this.otherProcesses.includes(event.sourceProcess) || // another process should be able to handle this
					this.otherProcesses.some(otherProcessId => otherProcessId < process.pid))) { // otherwise, defer to the lowest number process to handle it
				// we can skip these (unless they are in are queue, then we need to update)
				return event
			}
			if (id && !this.gettingAllIds) {
				const version = event.version
				this.updateProcessMap(version)
				// queue up processing the event
				let indexRequest = this.queue.get(id)
				if (indexRequest) {
					// put it at that end so version numbers are in order, but don't alter the previous state or version, that is still what we will be diffing from
					this.queue.delete(id)
					this.queue.set(id, indexRequest)
					indexRequest.version = version
					if (event.triggers)
						for (let trigger of event.triggers)
							indexRequest.triggers.add(trigger)
				} else {
					this.queue.set(id, indexRequest = {
						previousEntry,
						version: version,
						now: Date.now(),
						triggers: event.triggers instanceof Set ? event.triggers : new Set(event.triggers),
					})
					if (indexRequest.previousState == INVALIDATED_ENTRY) {
						indexRequest.previousValues = event.previousValues // need to have a shared map to update
						indexRequest.by = by
					}
					this.requestProcessing(DEFAULT_INDEXING_DELAY)
				}
				if (!version) {
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
				this.whenProcessingComplete.version = lastIndexedVersion
			}
			return this.whenProcessingComplete
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
		state: Index.state,
		pendingRequests: Array.from(Index.pendingRequests),
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