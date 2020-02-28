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
	let temporaryRestartDelay = 1000

	return class extends Persistable.as(VArray) {
		version: number
		averageConcurrencyLevel: number
		static Sources = [Source]
		static whenProcessingComplete: Promise<any> // promise for the completion of processing in current indexing task for this index
		static whenCommitted: Promise<any> // promise for when an update received by this index has been fully committed (to disk)
		static indexingProcess: Promise<any>
		static eventLog = []

		static async indexEntry(id, indexRequest: IndexRequest) {
			let { previousEntry, deleted, sources, triggers, version } = indexRequest
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
							data = await Source.get(id, INDEXING_MODE)
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
					temporaryRestartDelay *= 1.05
					this.state = 'retrying index in ' + temporaryRestartDelay + 'ms'
					await this.delay(temporaryRestartDelay)
					console.info('Retrying index entry', this.name, id, error)
					return
				}
				if (indexRequest.version !== version) return // if at any point it is invalidated, break out, don't log errors from invalidated states
				this.warn('Error indexing', Source.name, 'for', this.name, id, error)
			}
			temporaryRestartDelay = 1000
			this.queue.delete(id)
			let earliestPendingVersion
			for (const firstInQueue of this.queue) {
				earliestPendingVersion = firstInQueue.version
				break
			}
			let committed
			if (operations.length > 0) {
				committed = this.submitWrites(operations, previousVersion || 0)
			} else {
				// still need to update version and send event updates
				committed = Promise.resolve()
			}
			this.lastWriteCommitted = committed
			// update versions and send updates when promises resolve
			this.whenWritesComplete(committed, earliestPendingVersion, version, eventUpdateSources, idAsBuffer)

			if (indexRequest.resolveOnCompletion) {
				await committed
				for (const resolve of indexRequest.resolveOnCompletion) {
					resolve()
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
				return [entries]
			}
			return entries
		}

		static updateEarliestPendingVersion() {
			this.earliestPendingVersionInOtherProcesses = getNextVersion()
			if (!indexingState) {
				this.getIndexingState()
			}
			const processes = indexingState[1]
			for (let i = 1; i < processes + 1; i++) {
				let offset = i * 16
				let processVersion
				let pid
				if (offset != stateOffset && (processVersion = readUInt(indexingState, offset + 8)) !== 0 && (pid = readUInt(indexingState, offset)) !== 0) {
					if (processVersion < this.earliestPendingVersionInOtherProcesses || processVersion === this.earliestPendingVersionInOtherProcesses && pid < process.pid) {
						this.earliestPendingVersionInOtherProcesses = processVersion
						this.earliestProcess = pid
					}
				}
			}
		}
		static submitWrites(operations, previousVersion) {
			if (this.queuedWrites) {
				// if we are in queued/paused mode, all operations go in the queue until we get the green light from the other processe
				this.queuedWrites.push({
					previousVersion,
					operations,
				})
				return this.queuedRequestForWriteNotification
			} else if (previousVersion < this.earliestPendingVersionInOtherProcesses) {
				// previous version is earlier than all writes, proceed
				return this.db.batch(operations)
			} else {
				// first, read an updated earliestPendingVersion to see if it is still before our pending write
				this.updateEarliestPendingVersion()
				if (previousVersion < this.earliestPendingVersionInOtherProcesses) {
					// now previous version is earlier than all writes from other processes, proceed
					return this.db.batch(operations)
				} else {
					this.log('sendRequestToWrite batch', previousVersion)
					if (!this.queuedWrites)
						this.queuedWrites = []
					this.queuedWrites.push({
						previousVersion,
						operations,
					})
					if (!this.queuedRequestForWriteNotification) {
						this.queuedRequestForWriteNotification = Promise.resolve() // in case sendRequest throws
						this.queuedRequestForWriteNotification = this.sendRequestToWrite(this.earliestProcess, previousVersion).then(() => {
							this.queuedRequestForWriteNotification = null
							this.resumeWrites()
						})
					}
					return this.queuedRequestForWriteNotification
				}
			}
		}

		static pendingCommits = []
		static whenWritesComplete(committed, earliestPendingVersion, version, updateEventSources, id) {
			let lastPendingVersion
			committed.maxVersion = Math.max(committed.maxVersion || 0, version)

			let pendingEvents = this.pendingEvents.get(committed)
			if (this.pendingCommits.indexOf(committed) === -1) {
				this.pendingCommits.push(committed)
				committed.earliestVersion = earliestPendingVersion
				this.pendingEvents.set(committed, pendingEvents = [])
				committed.then(() => {
					this.pendingCommits.splice(this.pendingCommits.indexOf(committed), 1)
					this.pendingEvents.delete(committed)
					let myEarliestPendingVersion = this.whenWritesCommitted()
					lastPendingVersion = Math.min(myEarliestPendingVersion || (committed.maxVersion + 1), this.earliestPendingVersionInOtherProcesses)
					this.sendUpdates(pendingEvents)
					// once the commit has been flushed to disk, write the updated version number
					// update the global last version
					if (!indexingState) {
						this.getIndexingState()
					}
					if (this.isInitialBuild) {
						// write the last key indexed
						this.db.put(INITIALIZING_LAST_KEY, id)
					} else {
						lastIndexedVersion = lastPendingVersion - 1
						const versionWord = Buffer.alloc(8)
						writeUInt(versionWord, lastIndexedVersion)
						versionWord.copy(indexingState, 8) // copy word for an atomic update
					}
				})
			}
			pendingEvents.push(...updateEventSources)
			
			return committed
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
		static whenWritesCommitted() {
			let myEarliestPendingVersion = 0 // recompute this
			if (this.pendingCommits[0]) {
				myEarliestPendingVersion = this.pendingCommits[0].earliestVersion
			} else if (this.queue.size > 0) {
				for (let [, { version }] of this.queue) {
					myEarliestPendingVersion = version
					break
				}
			}
			this.updateProcessMap(myEarliestPendingVersion, true)
			this.updateEarliestPendingVersion()

			if (this.requestForWriteNotification) {
				for (const notification of this.requestForWriteNotification.slice()) {
					if (notification.version <= myEarliestPendingVersion || myEarliestPendingVersion == 0) {
						notification.whenWritten({ written: true })
						this.requestForWriteNotification.splice(this.requestForWriteNotification.indexOf(notification), 1)
					}
				}
			}
			return myEarliestPendingVersion
		}

		static resumeWrites() {
			this.log('resumeWrites batch')
			const resumedWrites = this.queuedWrites
			this.queuedWrites = null
			for (const { operations, previousVersion, version, updateEventSources } of resumedWrites) {
				this.submitWrites(operations, previousVersion, version, updateEventSources)
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

		static queue = new Map<any, IndexRequest>()
		static async processQueue() {
			this.state = 'processing'
			if (this.onStateChange) {
				this.onStateChange({ processing: true, started: true })
			}
			let cpuUsage = process.cpuUsage()
			let cpuTotalUsage = cpuUsage.user + cpuUsage.system
			let lastTime = Date.now()
			let concurrencyAdjustment = 1
			let niceAdjustment = 2
			try {
				let queue = this.queue
				let initialQueueSize = queue.size
				currentlyProcessing.add(this)
				if (initialQueueSize > 100) {
					this.log('Indexing', initialQueueSize, Source.name, 'for', this.name)
				}
				let indexingInProgress = []
				let indexingInOtherProcess = [] // TODO: Need to have whenUpdated wait on this too
				let actionsInProgress = []
				let sinceLastStateUpdate = 0
				do {
					if (this.nice > 0)
						await this.delay(this.nice) // short delay for other processing to occur
					for (let [id, indexRequest] of queue) {
						if (queue.isReplaced)
							return
						let { previousEntry } = indexRequest
						previousEntry = indexRequest.previousEntry = (previousEntry && previousEntry.then) ? await previousEntry : previousEntry
						if (previousEntry instanceof Invalidated) {
							// delete from our queue
							this.queue.delete(id)
							// delegate to other process
							indexingInOtherProcess.push(this.sendRequestToIndex(id, indexRequest).then(( { indexed }) => {
								if (indexed) {
								} else  {
									let newEntry = Source.getFromDB(id)
									if (newEntry instanceof Invalidated) {
										this.log('no process confirmed sendRequestToIndex, still invalidated, indexing locally', this.name, id)
										let event = new ReplacedEvent()
										event.version = indexRequest.version
										this.updated(event, { id })
									}
								}
							}))
							if (this.queue.size == 0) {
								// if our queue is empty, need to update our process map
								this.whenWritesCommitted()
							}
							continue // and don't add to count of concurrent indexing, as that could contribute to a deadlock
						}

						sinceLastStateUpdate++
						this.state = 'initiating indexing of entry'
						indexingInProgress.push(this.indexEntry(id, indexRequest))
						if (sinceLastStateUpdate > (Source.MAX_CONCURRENCY || DEFAULT_INDEXING_CONCURRENCY) * concurrencyAdjustment) {
							// we have process enough, commit our changes so far
							this.onBeforeCommit && this.onBeforeCommit(id)
							let indexingStarted = indexingInProgress
							indexingInProgress = []
							this.averageConcurrencyLevel = ((this.averageConcurrencyLevel || 0) + sinceLastStateUpdate) / 2
							sinceLastStateUpdate = 0
							this.state = 'awaiting indexing'
							await Promise.all(indexingStarted)
							this.state = 'finished indexing batch'
							let processedEntries = indexingStarted.length
							//this.saveLatestVersion(false)
							cpuUsage = process.cpuUsage()
							let lastCpuUsage = cpuTotalUsage
							cpuTotalUsage = cpuUsage.user + cpuUsage.system
							let currentTime = Date.now()
							let timeUsed = currentTime - lastTime
							lastTime = currentTime
							// calculate an indexing adjustment based on cpu usage and queue size (which we don't want to get too big)
							concurrencyAdjustment = (concurrencyAdjustment + 1000 / (1000 + timeUsed)) / 2
							niceAdjustment = (niceAdjustment + (cpuTotalUsage - lastCpuUsage) / (timeUsed + 10) / 20) / 2
							/* Can be used to measure performance
							let [seconds, billionths] = process.hrtime(lastStart)
							lastStart = process.hrtime()
							*/if (isNaN(niceAdjustment)) {
								console.log('speed adjustment', { concurrencyAdjustment, niceAdjustment, timeUsed, cpuTime: (cpuTotalUsage - lastCpuUsage) })
								niceAdjustment = 10
							}
							await this.delay(Math.round((this.nice * niceAdjustment) / (queue.size + 1000))) // short delay for other processing to occur
						}
					}
					this.state = 'waiting on other processes'
					this.state = 'awaiting final indexing'
					await Promise.all(indexingInProgress) // then wait for all indexing to finish everything
				} while (queue.size > 0)
				await this.lastWriteCommitted
				if (initialQueueSize > 100) {
					this.log('Finished indexing', initialQueueSize, Source.name, 'for', this.name)
				}
			} catch (error) {
				this.warn('Error occurred in processing index queue for', this.name, error, 'remaining in queue', this.queue.size)
			}
			this.state = 'processed'
			if (this.onStateChange) {
				this.onStateChange({ processing: true, started: false })
			}
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
			this.queue.clear()
			let idsAndVersionsToReindex
			idsAndVersionsToReindex = await Source.getInstanceIdsAndVersionsSince(lastIndexedVersion)
			let idsAndVersionsToInitialize
			if (lastIndexedVersion == 1 || idsAndVersionsToReindex.isFullReset) {
				this.log('Starting index from scratch ' + this.name + ' with ' + idsAndVersionsToReindex.length + ' to index')
				this.state = 'clearing'
				this.clearAllData()
				if (idsAndVersionsToReindex.length > 0)
					this.db.putSync(INITIALIZING_LAST_KEY, Buffer.from([1, 255]))
				this.updateDBVersion()
				this.log('Cleared index', this.name)
				idsAndVersionsToInitialize = idsAndVersionsToReindex
				idsAndVersionsToReindex = []
				writeUInt(this.getIndexingState(), lastIndexedVersion = idsAndVersionsToInitialize.lastVersion, 8)
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
			if (idsAndVersionsToReindex.length > 0) {
				this.state = 'resuming'
				idsAndVersionsToReindex.sort((a, b) => a.version > b.version ? 1 : a.version < b.version ? -1 : 0)
				this.log('Resuming from ', lastIndexedVersion, 'indexing', idsAndVersionsToReindex.length, this.name)
				const setOfIds = new Set(idsAndVersionsToReindex.map(({ id }) => id))
				// clear out all the items that we are indexing, since we don't have their previous state
				await clearEntries(Buffer.from([2]), (sourceId) => setOfIds.has(sourceId))

				this.state = 'initializing queue'
				for (let { id, version } of idsAndVersionsToReindex) {
					if (!version)
						this.log('resuming without version',this.name, id)
					this.queue.set(id, new InitializingIndexRequest(version))
				}
			} else {
				this.state = 'ready'
				return
			}
			//this.updateProcessMap(lastIndexedVersion)
			if (this.queue.size > 0) {
				this.state = 'processing'
				await this.requestProcessing(DEFAULT_INDEXING_DELAY)
			}
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
			return when(this.whenUpdatedInContext(), () => {
				let keyPrefix = toBufferKey(id)
				let iterable = this._getIndexedValues({
					start: Buffer.concat([keyPrefix, SEPARATOR_BYTE]), // the range of everything starting with id-
					end: Buffer.concat([keyPrefix, SEPARATOR_NEXT_BYTE]),
					recordApproximateSize: true,
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
			context = context || currentContext
			let updateContext = (context && context.expectedVersions) ? context : DEFAULT_CONTEXT
			return when(when(Source.whenUpdatedInContext(), () => {
				// Go through the expected source versions and see if we are behind and awaiting processing on any sources
				for (const sourceName in updateContext.expectedVersions) {
					// if the expected version is behind, wait for processing to finish
					if (updateContext.expectedVersions[sourceName] > (sourceVersions[sourceName] || 0) && this.queue.size > 0)
						return this.requestProcessing(1) // up the priority
				}
			}), () => {
				if (context)
					context.setVersion(lastIndexedVersion)
			})
		}

		// static returnsIterables = true // maybe at some point default this to on

		static getInstanceIdsAndVersionsSince(version) {
			// There is no version tracking with indices.
			// however, indices always do send updates, and as long as we wait until we are ready and finished with initial indexing
			// downstream tables should have received all the updates they need to proceed
			//console.log('getInstanceIdsAndVersionsSince from KeyIndex', this.name, version)
			return this.ready.then(() => {
				this.log('getInstanceIdsAndVersionsSince ready from KeyIndex', this.name, version)
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

		static getIndexingState(onlyTry?) {
			this.db.get(INDEXING_STATE, buffer => indexingState = buffer)
			if (indexingState && indexingState.buffer.byteLength > 4000) {
				debugger
				throw new Error('Indexing state is not shared, can not continue')
			}
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
				this.warn('No free indexing process slots, need to reset indexing state table')
				indexingState.fill(0, 0, INDEXING_STATE_SIZE)
				stateOffset = 16
				writeUInt(indexingState, process.pid, stateOffset)
				indexingState[1] = 1
			})
			db.on('remap', (forceUnload) => {
				this.log('onInvalidation of indexingState')
				//if (forceUnload === true) {
				indexingState = null
				//} else {
				//	return false // if it is not forced, indicate that it is always up-to-date (we never overwrite this entry)
				//}
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
				return this.resumeIndex()
			})
		}
		static myEarliestPendingVersion = 0 // have we registered our process, and at what version
		static whenAllConcurrentlyIndexing?: Promise<any> // promise if we are waiting for the initial indexing process to join the concurrent indexing mode
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
		static sendRequestToIndex(id, indexRequest) {

			this.log('sendRequestToIndex', id, this.name, 'version', indexRequest.version, 'previousVersion', indexRequest.previousVersion)
			if (!this.sendRequestToProcess) {
				return Promise.resolve({ indexed: false })
			}
			const request = {
				id,
				version: indexRequest.version,
				previousVersion: indexRequest.previousVersion,
				waitFor: 'index',
			}
			this.pendingRequests.set(id, {
				request
			})
			return withTimeout(this.sendRequestToAllProcesses(request), 60000).then(responses => {
				return {
					indexed: responses.some(({ indexed }) => indexed)
				}
			}, error => {
				this.log('Error on waiting for indexed', this.name, 'index request', request, error.toString())
				return { indexed: false }
			}).finally((indexed) => {
				this.pendingRequests.delete(id)
				//console.log('sendRequestToIndex finished', id, this.name, indexed)
			})
		}
		static sendRequestToWrite(pid, version) {
			try {
				return withTimeout(this.sendRequestToProcess(pid, {
					version,
					waitFor: 'write',
				}), 60000).catch(error => {
					this.log('Error on waiting for writing index', this.name, 'from process', pid, 'index request', version, error.toString())
					return { indexed: false }
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

		static receiveRequest({ id, version, previousVersion, waitFor }) {
			if (waitFor == 'write') {
				if (this.queue.size === 0) {
					// if nothing in queue, wait for last write and return
					return when(this.lastWriteCommitted, () => ({ written: true }))
				}
				if (this.queuedRequestForWriteNotification) {
					// if we are waiting for other processes, let it proceed, so don't deadlock
					// (it is possible for a sequence of processes to wait on each other, but we won't worry about that for now)
					return when(this.lastWriteCommitted, () => ({ written: true }))
				}
				if (!this.requestForWriteNotification) {
					this.requestForWriteNotification = []
				}
				return new Promise(resolve => {
					this.requestForWriteNotification.push({
						version,
						whenWritten: resolve
					})
				})
			}
			// else if (waitFor == 'index') {
			const updateInQueue = this.queue.get(id);
			if (updateInQueue) {
				if (updateInQueue.version < version) {
					// update our version number to be the latest
					updateInQueue.version = version
				}
				//console.log('receiveRequest', id, this.name, 'version', version, 'previousVersion', previousVersion, 'will handle')
				return new Promise(resolve =>
					(updateInQueue.resolveOnCompletion || (updateInQueue.resolveOnCompletion = [])).push(resolve))
					.then(() => ({ indexed: true })) // reply when we have finished indexing this
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

			let previousEntry = by && by.previousEntry
			let id = by && (typeof by === 'object' ? by.id : by) // if we are getting an update from a source instance
			if (by && by.constructor === this || // our own instances can notify us of events, ignore them
				this.otherProcesses && event.sourceProcess && 
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
					/*if (indexRequest.previousState == INVALIDATED_ENTRY) {
						indexRequest.previousValues = event.previousValues // need to have a shared map to update
						indexRequest.by = by
					}*/
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
					this.processQueue()).then(() => {
						this.state = 'ready'
						this.whenProcessingComplete = null
						currentlyProcessing.delete(this)
						for (const sourceName in processingSourceVersions) {
							sourceVersions[sourceName] = processingSourceVersions[sourceName]
						}
						/*const event = new IndexingCompletionEvent()
						event.sourceVersions = sourceVersions
						event.sourceVersions[this.name] = lastIndexedVersion
						super.updated(event, this)*/
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
		queued: Index.queue.size,
		state: Index.state,
		concurrencyLevel: Index.averageConcurrencyLevel,
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
