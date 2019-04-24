import { Transform, VPromise, VArray, Variable, spawn, currentContext, NOT_MODIFIED, getNextVersion, ReplacedEvent, DeletedEvent, AddedEvent, UpdateEvent, Context } from 'alkali'
import { createSerializer, serialize, parse, parseLazy, createParser, asBlock, isBlock, copy, reassignBuffers } from 'dpack'
import * as lmdb from 'lmdb-store'
import when from './util/when'
import { WeakValueMap } from 'lmdb-store/util/WeakValueMap'
import ExpirationStrategy from './ExpirationStrategy'
import * as fs from 'fs'
import * as crypto from 'crypto'
import Index from './KeyIndex'
import { AccessError, ConcurrentModificationError } from './util/errors'
import { toBufferKey, fromBufferKey } from 'ordered-binary'
import { Database, IterableOptions, OperationsArray } from './storage/Database'
//import { mergeProgress } from './UpdateProgress'
import { registerClass, addProcess } from './util/process'
import { DEFAULT_CONTEXT, RequestContext } from './RequestContext'
let lz4Compress, lz4Uncompress
try {
	lz4Compress = require('lz4').encodeBlock
	lz4Uncompress = require('lz4').decodeBlock
} catch(error) {
	lz4Compress = () => 0 // compression always fails if not loaded
}

const expirationStrategy = ExpirationStrategy.defaultInstance
const instanceIdsMap = new WeakValueMap()
const DB_VERSION_KEY = Buffer.from([1, 1]) // table metadata 1
const LAST_VERSION_IN_DB_KEY = Buffer.from([1, 3]) // table metadata 2
const INITIALIZING_PROCESS_KEY = Buffer.from([1, 4])
const INITIALIZATION_SOURCE = 'is-initializing'
const SHARED_MEMORY_THRESHOLD = 1024
export const INVALIDATED_ENTRY = { state: 'invalidated'}
const INVALIDATED_STATE = 1
const NO_COPY_OPTIONS = {
	noCopy: true
}
const COMPRESSED_STATUS_24 = 254
const COMPRESSED_STATUS_48 = 255
const COMPRESSION_THRESHOLD = 1500
const AS_SOURCE = {}
const EXTENSION = '.mdpack'

export const VERSION = Symbol('version')
export const STATUS_BYTE = Symbol('statusByte')

let globalDoesInitialization

global.cache = expirationStrategy // help with debugging

class InstanceIds extends Transform.as(VArray) {
	Class: any
	cachedValue: any
	cachedVersion: any
	transform() {
		return when(this.Class.resetProcess, () => this.Class.getInstanceIds())
	}
	getValue() {
		return when(super.getValue(true), ids => {
			expirationStrategy.useEntry(this, ids.length)
			return ids
		})
	}
	valueOf() {
		return super.valueOf(true) // always allow promises to be returned
	}
	clearCache() {
		this.cachedValue = undefined
		this.cachedVersion = -1
	}
}

const MakePersisted = (Base) => secureAccess(class extends Base {
	static DB: any
	static syncVersion: number
	static Cached: any
	_cachedValue: any
	_cachedVersion: number
	_versions: any
	version: number
	static useWeakMap = true
	static dbFolder = 'cachedb'
	static db: Database
	db: Database
	repetitiveGets: boolean

	static updatingProcessConnection: {
		sendMessage(data: any): Promise<any>
	}

	constructor(id) {
		super()
		if (id == null) {
			throw new TypeError('No id provided')
		}
		if (this.constructor === Persisted) {
			throw new TypeError('Can not directly instantiate abstract Persisted class')
		}
		if (this.checkSourceVersions)
			this.readyState = 'invalidated' // start in this state for items that might not be updated so freshly loaded entities don't bypass version checks
		this.id = id
	}

	get staysUpdated() {
		return true
	}

	static get defaultInstance() {
		return this._defaultInstance || (this._defaultInstance = new Variable())
	}

	static for(id) {
		if (id > 0 && typeof id === 'string' || id == null) {
			throw new Error('Id should be a number or non-numeric string: ' + id + 'for ' + this.name)
		}
		let instancesById = this.instancesById
		if (!instancesById) {
			this.ready
			instancesById = this.instancesById
		}
		let instance = instancesById.get(id)
		if (!instance) {
			instance = new this(id)
			instancesById.set(id, instance)
		}
		return instance
	}

	static getByIds(ids) {
		// for optimized access to a set of ids
		if (!(ids instanceof Array))
			ids = Array.from(ids)
		let i = 0, l = ids.length
		let values = []
		let promised = []
		const getNext = () => {
			while (i < l) {
				let value = this.for(ids[i])
				if (value && value.then) {
					// a promise, put in the list of parallel promises
					let promisedI = i++
					promised.push(value.then(value => {
						values[promisedI] = value
					}))
					if (promised.length > (this.MAX_CONCURRENCY || 100)) {
						let promisedToFinish = promised
						promised = []
						return Promise.all(promisedToFinish).then(getNext)
					}
				} else {
					values[i++] = value
				}
			}
			if (promised.length > 0) {
				return Promise.all(promised)
			}
		}
		return when(getNext(), () => values)
	}

	static assignPreviousValue(id, by) {
		by.previousValue = this.getFromDB(id)
	}

	static index(propertyName: string, indexBy?: (value, sourceKey) => any) {
		let index = this['index-' + propertyName]
		if (index) {
			return index
		}
		index = this['index-' + propertyName] = class extends Index({ Source : this }) {
			static indexBy(entity, sourceKey) {
				return indexBy ? indexBy(entity, sourceKey) : entity[propertyName]
			}
		}
		Object.defineProperty(index, 'name', { value: this.name + '-index-' + propertyName })
		index.start()
		return index
	}

	static reduce(name: string, reduceFunction: (accumulator, nextValue) => any) {
		let reduced = this['reduced-' + name]
		if (reduced) {
			return reduced
		}
		reduced = this['reduced-' + name] = class extends Reduced.from(this) {
			static reduceBy(a, b) {
				return reduceFunction.call(this, a, b)
			}
		}
		Object.defineProperty(reduced, 'name', { value: this.name + '-reduced-' + name })
		return reduced
	}

/*	static with(properties) {
		let DerivedClass = super.with(properties)
		DerivedClass.Sources = [this]
		let hasRelatedProperties
		for (let key of properties) {
			let property = properties[key]
			if (property.initialized) {
				property.initialized(this)
				hasRelatedProperties = true
			}

		}
		if (hasRelatedProperties) {
			DerivedClass.prototype.transform = function(data, ...propertySources) {
				for (let propertySource of propertySources) {
					data[DerivedClass.Sources[i].key] = propertySource
				}
				return data
			}
		}
		return DerivedClass
	}*/

	static relatesBy(foreignKey: string) {
		let TargetClass = this
		function relatesBy() {}
		relatesBy.defineAs = function(propertyName, Parent) {
			let RelatedIndex = TargetClass.index(foreignKey)
			let sourceIndex = Parent.Sources.push(RelatedIndex) - 1
			let existingTransform = Parent.prototype.transform
			Parent.prototype.transform = function(primaryData) {
				if (existingTransform) {
					primaryData = existingTransform.apply(this, arguments)
				}
				let source = arguments[sourceIndex]
				return Object.assign({ [propertyName]: source }, primaryData)
			}
			Parent.assign({
				[propertyName]: VArray.of(TargetClass)
			})
		}
		return relatesBy
	}

	static relatedBy(foreignKey: string) {
		let TargetClass = this
		function relatedBy() {}
		relatedBy.defineAs = function(propertyName, Parent) {
			let ParentSource = Parent.Sources[0]
			let RelatedIndex = ParentSource.index(foreignKey)
			let existingTransform = Parent.prototype.transform
			Parent.prototype.transform = function(primaryData) {
				if (existingTransform) {
					primaryData = existingTransform.apply(this, arguments)
				}
				return when(primaryData, primaryData => {
					let reference = foreignKey.call ? foreignKey(primaryData) : primaryData[foreignKey]
					return (reference instanceof Array ?
						Promise.all(reference.map(ref => TargetClass.for(ref))) :
						TargetClass.for(reference)).then(relatedValue =>
						Object.assign({ [propertyName]: relatedValue }, primaryData))
				})
			}
			TargetClass.notifies({
				updated(event, by) {
					RelatedIndex.for(by.id).getIndexedKeys().map(fromId => {
						Parent.for(fromId).updated(event)
					}).resolveData()
				}
			})
			Parent.assign({
				[propertyName]: TargetClass
			})
		}
		return relatedBy
	}

	static cacheWith(properties) {
		const CachedWith = Cached.from(this).assign(properties)
		Object.defineProperty(CachedWith, 'name', {
			value: this.name + '-with-' + Object.keys(properties).filter(key => properties[key] && properties[key].defineAs).join('-')
		})
		CachedWith.start()
		return CachedWith
	}

	transform(source) {
		return source
	}

	static updatesRecorded(event) {
		return (event && event.updatesInProgress) ? Promise.all(event.updatesInProgress) : Promise.resolve()
	}

	delete() {
		return this.constructor.remove(this.id)
	}

	reset(action) {
		this.updated()
	}

	static get ready() {
		return this.start()
	}
	static start() {
		if (!this.hasOwnProperty('_ready')) {
			let resolver
			this._ready = new Promise(resolve => resolver = resolve)
			const initializeReturn = this.initialize()
			resolver(initializeReturn)
			this._ready.then(() => {
				//console.log(this.name, 'is ready and initialized')
				this.initialized = true
			}, (error) => {
				console.error('Error initializing', this.name, error)
			})
		}
		return this._ready
	}

	static clearAllData() {
		let db = this.db
		let count = 0
		db.transaction(() => {
			// we need to preserve the persistent metadata when we clear the db
			for (const { key } of db.iterable({
				values: false,
				start: Buffer.from([1, 6]) // start after the metadata
			})) {
				db.removeSync(key)
				count++
			}
		})
		console.info('Cleared the database', this.name, 'of', count, 'entries, rebuilding')
	}

	static register(sourceCode?: { id?: string, version?: number }) {
		// check the transform hash
		if (sourceCode) {
			let moduleFilename = sourceCode.id || sourceCode
			if (sourceCode.version) {
				// manually provide hash
				this.version = sourceCode.version
			} else if (typeof moduleFilename == 'string') {
				// create a hash from the module source
				this.version = fs.statSync(moduleFilename).mtime.getTime()
				let hmac = crypto.createHmac('sha256', 'cobase')
				hmac.update(fs.readFileSync(moduleFilename, { encoding: 'utf8' }))
			this.transformHash = hmac.digest('hex')
			}
		}
		return this.ready
	}

	static get doesInitialization() {
		return this._doesInitialization === undefined ? globalDoesInitialization : this._doesInitialization
	}
	static set doesInitialization(flag) {
		this._doesInitialization = flag
	}
	static initializeDB() {
		const options = {}
		if (this.mapSize) {
			options.mapSize = this.mapSize
		}
		if (this.useWritemap !== undefined) {
			// useWriteMap provides better performance
			options.useWritemap = this.useWritemap
		}
		if (clearOnStart) {
			console.info('Completely clearing', this.name)
			options.clearOnStart = true
		}
		const db = this.db

		const processKey = Buffer.from([1, 3, (process.pid >> 24) & 0xff, (process.pid >> 16) & 0xff, (process.pid >> 8) & 0xff, process.pid & 0xff])
		let initializingProcess
		db.transaction(() => {
			initializingProcess = db.get(INITIALIZING_PROCESS_KEY)
			initializingProcess = initializingProcess && +initializingProcess.toString()
			this.otherProcesses = Array.from(db.iterable({
				start: Buffer.from([1, 3]),
				end: INITIALIZING_PROCESS_KEY,
			}).map(({key, value}) => (key[2] << 24) + (key[3] << 16) + (key[4] << 8) + key[5])).filter(pid => !isNaN(pid))
			db.putSync(processKey, Buffer.from([])) // register process, in ready state
			if (!initializingProcess || !this.otherProcesses.includes(initializingProcess)) {
				initializingProcess = null
				db.putSync(INITIALIZING_PROCESS_KEY, Buffer.from(process.pid.toString()))
			}
			if (this.otherProcesses.includes(process.pid)) {
				//console.warn('otherProcesses includes self')
				this.otherProcesses.splice(this.otherProcesses.indexOf(process.pid))
			}
		})
		let versionBuffer = db.get(LAST_VERSION_IN_DB_KEY)
		this.lastVersion = versionBuffer ? readUInt(versionBuffer) : 0
		let stateDPack = db.get(DB_VERSION_KEY)
		let didReset
		let state = stateDPack && parse(stateDPack)
		if (state) {
			this.dbVersion = state.dbVersion
			this.startVersion = state.startVersion
		}
		return initializingProcess
	}


	static getStructureVersion() {
		// default version handling is just to get the static version, but this can be overriden with something
		// that gets this asynchronously
		return this.version		
	}

	static initialize() {
		this.instancesById = new (this.useWeakMap ? WeakValueMap : Map)()
		
		clearTimeout(this._registerTimeout)
		if (global[this.name]) {
			throw new Error(this.name + ' already registered')
		}
		global[this.name] = this
		for (let Source of this.Sources || []) {
			Source.notifies(this)
		}
		const options = {}
		if (this.mapSize) {
			options.mapSize = this.mapSize
		}
		if (this.useWritemap !== undefined) {
			// useWriteMap provides better performance
			options.useWritemap = this.useWritemap
		}
		if (clearOnStart) {
			console.info('Completely clearing', this.name)
			options.clearOnStart = true
		}
		const db = this.prototype.db = this.db = Persisted.DB.open(this.dbFolder + '/' + this.name + EXTENSION, options)
		this.instancesById.name = this.name
		let doesInitialization = Persisted.doesInitialization && false
		return when(this.getStructureVersion(), dbVersion => {
			console.log("db version", this.name, dbVersion)
			this.version = dbVersion
			let initializingProcess = this.initializeDB()
			const db = this.db
			registerClass(this)

			let whenEachProcess = []
			//console.log('Connecting', this.name, 'to processes', this.otherProcesses)
			for (const pid of this.otherProcesses) {
				whenEachProcess.push(addProcess(pid, this).catch(() => {
					this.cleanupDeadProcessReference(pid, initializingProcess)
				}))
			}
			// make sure these are inherited
			if (initializingProcess/* || !Persisted.doesInitialization*/) {
				// there is another process handling initialization
				return when(whenEachProcess.length > 0 && Promise.all(whenEachProcess), () => {
					//console.log('Connected to each process complete and finished initialization', this.name)
				})
			}
			return this.doDataInitialization()
		})
	}

	static doDataInitialization() {
		//console.log('start data initialization', this.name)
		const versionBuffer = this.db.get(LAST_VERSION_IN_DB_KEY)
		this.lastVersion = Math.max(this.lastVersion, versionBuffer ? readUInt(versionBuffer) : 0) // re-retrieve this, it could have changed since we got a lock
		const whenFinished = () => {
			try {
				this.db.remove(INITIALIZING_PROCESS_KEY)
				//console.log('finished data initialization', this.name)
			} catch (error) {
				console.warn(error.toString())
			}
		}
		try {
			return when(this.initializeData(), () => {
				//console.log('Finished initializeData', this.name)
				this.updateDBVersion()
				whenFinished()
			}, (error) => {
				console.error(error)
				whenFinished()
			})
		} catch (error) {
			console.error(error)
			whenFinished()
		}
	}
	static cleanupDeadProcessReference(pid, initializingProcess) {
		// error connecting to another process, which means it is dead/old and we need to clean up
		// and possibly take over initialization
		let index = this.otherProcesses.indexOf(pid)
		const db = this.db
		if (index > -1) {
			this.otherProcesses.splice(index, 1)
			db.remove(Buffer.from([1, 3, (pid >> 24) & 0xff, (pid >> 16) & 0xff, (pid >> 8) & 0xff, pid & 0xff]))
		}
		if (initializingProcess == pid) {
			let doInit
			db.transaction(() => {
				// make sure it is still the initializing process
				initializingProcess = db.get(Buffer.from([1, 4]))
				initializingProcess = initializingProcess && +initializingProcess.toString()
				if (initializingProcess == pid) {
					// take over the initialization process
					//console.log('Taking over initialization of', this.name, 'from process', initializingProcess)
					db.putSync(INITIALIZING_PROCESS_KEY, Buffer.from(process.pid.toString()))
					doInit = true
				}
			})
			if (doInit) {
				return this.doDataInitialization()
			}
		}

	}
	static initializeData() {
		const db = this.db
		if (this.dbVersion == this.version) {
			// update to date
		} else {
			console.log('transform/database version mismatch, reseting db table', this.name, this.dbVersion, this.version)
			this.startVersion = getNextVersion()
			const clearDb = !!this.dbVersion // if there was previous state, clear out all entries
			return when(this.resetAll(clearDb), () => clearDb)
		}
	}

	valueOf(mode) {
		return super.valueOf(mode || true)
	}

	getValue(mode) {
		return this.constructor.get(this.id, mode)
	}

	gotValue(value) {
		// bypass any variable checks, since the data is coming from a DB
		return value
	}
	updated(event = new ReplacedEvent(), by?) {
		if (!event.visited) {
			event.visited = new Set() // TODO: Would like to remove this at some point
		}
		if (!event.source) {
			event.source = this
		}
		let context = currentContext
		if (context && !event.triggers && context.connectionId) {
			event.triggers = [ context.connectionId ]
		}

		let Class = this.constructor as PersistedType
		super.updated(event, by)
		Class.updated(event, this) // main handling occurs here
		// notify class listeners too
		return event
	}

	static instanceSetUpdated(event) {
		let instanceIds = instanceIdsMap.get(this.name)
		if (instanceIds) {
			instanceIds.updated(event)
		}
	}

	static writeEntry(event) {
	}

	static update(id, event) {
		// this an easier way to manually call the updated process
		return this.updated(new ReplacedEvent(), { id })
	}

	static updated(event = new ReplacedEvent(), by?) {
		if (!event.visited) {
			event.visited = new Set() // TODO: Would like to remove this at some point
		}
		if (event.visited.has(this)) {
			return event
		}
		event.visited.add(this)
		let context = currentContext
		if (context && !event.triggers && context.connectionId) {
			event.triggers = [ context.connectionId ]
		}

		if (event && !event.version) {
			event.version = getNextVersion()
		}
		let id = by && by.id
		let nextBy = {
			id,
			constructor: this
		}
		if (!event.source) {
			event.source = nextBy
		}
		if (event.type === 'discovered' || event.type === 'added' || event.type === 'deleted') {
			this.instanceSetUpdated(event)
		}
		if (event.type === 'reload-entry' || event.type === 'discovered' ) {
			// if we are being notified of ourself being created, ignore it
			// do nothing
		} else if (id) {
			this.writeEntry(id, event, nextBy)
		}
		if (id) {
			let instance
			instance = this.instancesById.get(id)
			if (instance)
				instance.updated(event, nextBy)
		}
		for (let listener of this.listeners || []) {
			listener.updated(event, nextBy)
		}

		if (!context || !context.expectedVersions) {
			context = DEFAULT_CONTEXT
		}
		context.expectedVersions[this.name] = event.version
		const whenUpdateProcessed = event.whenUpdateProcessed
		if (whenUpdateProcessed) {
			this.whenUpdateProcessed = whenUpdateProcessed
		}

		return event
	}

	static updateDBVersion() {
		let version = this.startVersion
		this.db.put(DB_VERSION_KEY, serialize({
			startVersion: version,
			dbVersion: this.version
		}))
		let versionBuffer = Buffer.allocUnsafe(8)
		writeUInt(versionBuffer, this.lastVersion)
		this.db.put(LAST_VERSION_IN_DB_KEY, versionBuffer)
		return version
	}

	notifies(target) {
		let context = currentContext
		if (context) {
			(this.listenersWithContext || (this.listenersWithContext = new Map())).set(target, context)
		}
		return super.notifies(target)
	}
	stopNotifies(target) {
		// standard variable handling
		if (this.listenersWithContext) {
			this.listenersWithContext.delete(target)
		}
		return super.stopNotifies(target)
	}
	static subscribedInstances: Map
	init() {
		if (!this.subscribedInstances) {
			this.subscribedInstances = new Map()
		}
		this.subscribedInstances.set(this.id, this)
		return super.init()
	}
	cleanup() {
		this.subscribedInstances.delete(this.id)
		return super.cleanup()		
	}

	static notifies(target) {
		let context = currentContext
		if (context) {
			(this.listenersWithContext || (this.listenersWithContext = new Map())).set(target, context)
		}
		// standard variable handling (don't use alkali's contextual notifies)
		return Variable.prototype.notifies.call(this, target)
	}
	static stopNotifies(target) {
		// standard variable handling
		if (this.listenersWithContext) {
			this.listenersWithContext.delete(target)
		}
		return Variable.prototype.stopNotifies.call(this, target)
	}
	static whenUpdatedInContext() {
		// transitively wait on all sources that need to update to this version
		let promises = []
		for (let Source of this.Sources || []) {
			let whenUpdated = Source.whenUpdatedInContext && Source.whenUpdatedInContext()
			if (whenUpdated && whenUpdated.then) {
				promises.push(whenUpdated)
			}
		}
		if (promises.length > 1) {
			return Promise.all(promises)
		} else if (promises.length == 1) {
			return promises[0]
		}
	}
	static get instanceIds() {
		let instanceIds = instanceIdsMap.get(this.name)
		if (!instanceIds) {
			instanceIdsMap.set(this.name, instanceIds = new InstanceIds())
			instanceIds.Class = this
		}
		return instanceIds
	}
	exclusiveLock(executeWithLock: () => any) {
		let promisedResult
		if (this.currentLock) {
			let context = currentContext
			const executeInContext = () => context.executeWithin(executeWithLock)
			promisedResult = this.currentLock.then(executeInContext, executeInContext)
		} else {
			let result = executeWithLock()
			if (result && result.then)
				promisedResult = result
			else
				return result
		}
		let thisLock, sync
		const afterExecution = () => {
			if (thisLock === this.currentLock) {
				this.currentLock = null
			}
			sync = true
		}
		thisLock = this.currentLock = promisedResult.then(afterExecution, (error) => {
			// Probably need to review if uncaught promise rejections are properly handled
			console.error(error)
			afterExecution()
		})
		if (sync) {
			this.currentLock = null
		}
		return promisedResult
	}
	static compressEntry(buffer, headerSize) {
		//console.log('compressing', this.name, buffer.length, typeof mode == 'object' && buffer.length > 1024)
		let compressedData = Buffer.allocUnsafe(buffer.length - 100)
		let uncompressedLength = buffer.length - headerSize
		let longSize = uncompressedLength >= 0x1000000
		let prefixSize = (longSize ? 8 : 4) + headerSize
		let compressedLength = lz4Compress(headerSize ? buffer.slice(headerSize) : buffer, compressedData, prefixSize, compressedData.length)
		if (compressedLength) {
			if (headerSize)
				buffer.copy(compressedData, 0, 0, headerSize)
			if (longSize) {
				writeUInt(buffer, uncompressedLength, headerSize)
				compressedData[0] = COMPRESSED_STATUS_48
			} else {
				compressedData.writeUInt32BE(uncompressedLength, headerSize)
				compressedData[0] = COMPRESSED_STATUS_24
			}
			buffer = compressedData.slice(0, prefixSize + compressedLength)
		} // else it didn't compress any smaller, bail out
		return buffer
	}

	static uncompressEntry(buffer, statusByte, headerSize) {
		// uncompress from the shared memory
		// TODO: Do this on-access
		let uncompressedLength, prefixSize
		if (statusByte == COMPRESSED_STATUS_24) {
			uncompressedLength = buffer.readUIntBE(headerSize + 1, 3)
			prefixSize = headerSize + 4
		} else if (statusByte == COMPRESSED_STATUS_48) {
			uncompressedLength = readUInt(buffer, headerSize)
			prefixSize = headerSize + 8
		} else {
			throw new Error('Unknown status byte ' + statusByte)
		}
		let uncompressedBuffer = Buffer.allocUnsafe(uncompressedLength)
		lz4Uncompress(buffer.slice(prefixSize), uncompressedBuffer)
		return uncompressedBuffer			
	}

	static _dpackStart = 8
	static setupSizeTable(buffer, start, headerSize) {
		let sizeTableBuffer = buffer.sizeTable
		let startOfSizeTable = start - (sizeTableBuffer ? sizeTableBuffer.length : 0)
		if (sizeTableBuffer) {
			if (startOfSizeTable - headerSize < 0) {
				this._dpackStart = sizeTableBuffer.length + headerSize
				return Buffer.concat([Buffer.alloc(headerSize), sizeTableBuffer, buffer.slice(start)])
			}
			sizeTableBuffer.copy(buffer, startOfSizeTable)
		}
		return buffer.slice(startOfSizeTable - headerSize)
	}
})

const KeyValued = (Base, { versionProperty, valueProperty }) => class extends Base {

	get dPackMultiplier() {
		return 1
	}

	get approximateSize() {
		return this.asDPack ? this.asDPack.length * this.dPackMultiplier : 100
	}
	static get transitions() {
		return this._transitions || (this._transitions = new Map())
	}
	static get(id, mode) {
		let context = currentContext
		/*
		if (context && !this.allowDirectJSON && context.ifModifiedSince > -1) {
			context.ifModifiedSince = undefined
		}*/
		let entry = this.getFromDB(id)
		if (typeof mode === 'object') {
			entry = copy(entry)
		}
		return entry
	}

	static is(id, value, event) {
		if (!event) {
			let entry = this.getFromDB(id)
			event = entry ? new ReplacedEvent() : new AddedEvent()
		}
		event.triggers = [ INITIALIZATION_SOURCE ]
		event.source = { constructor: this, id }

		this.updated(event, { id })
		let transition = this.transitions.get(id)
		if (transition) { // non cache entities won't have a transition
			transition.invalidating = false
			transition.result = value
		}
		let buffer = this.serializeEntryValue(value, event.version, true)
		return this.db.put(toBufferKey(id), buffer)
	}



	static getFromDB(id, conditional?) {
		let transition = this.transitions.get(id) // if we are transitioning, return the transition result
		if (transition) {
			if (transition.invalidating) {
				return new Invalidated(transition.newVersion, transition)
			} else {
				return transition.result
			}
		}
		let db = this.db
		// TODO: only read from DB if context specifies to look for a newer version
		let key = toBufferKey(id)
		let entryBuffer = db.get(key, NO_COPY_OPTIONS)
		if (!entryBuffer)
			return
		const version = readUInt(entryBuffer)
		if (entryBuffer[0] === INVALIDATED_STATE) {
			return new Invalidated(version)
		}
		let valueCache = this._valueCache
		if (valueCache) {
			let value = valueCache.get(id)
			if (value && value[VERSION] === version) {
				expirationStrategy.useEntry(value, entryBuffer.length >> (entryBuffer.buffer.onInvalidation ? 2 : 0))
				return value
			}
		} else {
			this._valueCache = valueCache = new WeakValueMap()
		}
		let value = this.parseEntryValue(entryBuffer)
		valueCache.set(id, value)
		if (value)
			expirationStrategy.useEntry(value, entryBuffer.length >> (entryBuffer.buffer.onInvalidation ? 2 : 0))
		return value
	}

	static parseEntryValue(buffer) {
		const version = readUInt(buffer)
		let valueBuffer, data
		let statusByte = buffer[0]
		if (statusByte >= COMPRESSED_STATUS_24) {
			valueBuffer = this.uncompressEntry(buffer, statusByte, 8)
		} else if (statusByte === INVALIDATED_STATE) {
			// stored as an invalidated version
			return new Invalidated(version)
		} else if (false && buffer.length > SHARED_MEMORY_THRESHOLD) {
			// use shared memory
			valueBuffer = buffer.slice(8)
			this.db.notifyOnInvalidation(buffer, function(forceCopy) {
				// TODO: if state byte indicates it is still fresh && !forceCopy:
				// TODO: Move this into cobase and search through cached blocks to find ones that need reassignment
				// return false
				// calling Buffer.from on ArrayBuffer returns NodeBuffer, calling again copies it
				data && reassignBuffers(data, Buffer.from(Buffer.from(this)), this)
				this.onInvalidation = null // nothing more we can do at this point
			})
		} else { 
			// Do a memcpy of the memory so we aren't using a shared memory
			valueBuffer = Buffer.from(buffer.slice(8))
		}
		data = parseLazy(valueBuffer, createParser())
		let type = typeof data
		if (type === 'object') {
			// nothing to change
			if (!data) {
				return null // can't assign version to null
			}
		} else if (type === 'number') {
			data = new Number(data)
		} else if (type === 'string') {
			data = new String(data)
		} else if (type === 'boolean') {
			data = new Boolean(data)
		} else {
			return data // can't assign a version to undefined
		}
		data[VERSION] = version
		data[STATUS_BYTE] = statusByte
		return data
	}

	static getInstanceIds(range: IterableOptions) {
		let db = this.db
		let options: IterableOptions = {
			start: Buffer.from([4]),
			values: false
		}
		if (range) {
			if (range.start != null)
				options.start = toBufferKey(range.start)
			if (range.end != null)
				options.end = toBufferKey(range.end)
		}
		return db.iterable(options).map(({ key }) => fromBufferKey(key)).asArray
	}

	static entries(opts) {
		let db = this.db
		return db.iterable({
			start: Buffer.from([2])
		}).map(({ key, value }) => {
			let entry = this.parseEntryValue(value)
			return {
				key: fromBufferKey(key),
				value: entry,
				version: entry && entry[VERSION],
			}
		}).asArray
	}

	/**
	* Iterate through all instances to find instances since the given version
	**/
	static getInstanceIdsAndVersionsSince(sinceVersion: number): { id: number, version: number }[] {
		console.log('getInstanceIdsAndVersionsSince', this.name, sinceVersion)
		return this.ready.then(() => {
			//console.log('getInstanceIdsAndVersionsSince ready and returning ids', this.name, sinceVersion)
			let db = this.db
			let versionBuffer = db.get(LAST_VERSION_IN_DB_KEY)
			this.lastVersion = this.lastVersion || (versionBuffer ? readUInt(versionBuffer) : 0)
			let isFullReset = this.startVersion > sinceVersion
			if (this.lastVersion && this.lastVersion <= sinceVersion && !isFullReset) {
				return []
			}
			const parser = createParser()
			return db.iterable({
				start: Buffer.from([10])
			}).map(({ key, value }) => {
				try {
					const version = readUInt(value)
					return version > sinceVersion ? {
						id: fromBufferKey(key),
						version
					} : null
				} catch (error) {
					console.error('Error reading data from table scan', this.name, fromBufferKey(key), error)
				}
			}).filter(idAndVersion => {
				return idAndVersion
			}).asArray.then(idsAndVersions => {
				if (idsAndVersions.length > 10000) {
					console.info('Sorting', idsAndVersions.length, 'versions of', this.name, 'for resuming updates, this may take some time')
				}
				idsAndVersions.sort((a, b) => a.version > b.version ? 1 : a.version < b.version ? -1 : 0)
				if (idsAndVersions.length > 10000) {
					console.info('Finished sorting', this.name)
				}
				idsAndVersions.isFullReset = isFullReset
				return idsAndVersions
			})
		})
	}

	static remove(id, event?) {
		if (id > 0 && typeof id === 'string' || !id) {
			throw new Error('Id should be a number or non-numeric string: ' + id)
		}
		
		return this.updated(event || (event = new DeletedEvent()), { id }).whenWritten
	}

	setValue(value) {
		this.constructor.is(this.id, value)
	}

	static serializeEntryValue(object, version, canCompress) {
		let start = this._dpackStart
		let buffer
		if (object === INVALIDATED_ENTRY) {
			buffer = Buffer.allocUnsafe(8)
		} else {
			buffer = serialize(object, {
				startOffset: start
			})
			buffer = this.setupSizeTable(buffer, start, 8)
		}

		buffer[0] = 0
		buffer[1] = 0
		writeUInt(buffer, version, 0)
		if (canCompress && buffer.length > COMPRESSION_THRESHOLD) {
			return this.compressEntry(buffer, 8)
		}
		return buffer
	}
}

export class Persisted extends KeyValued(MakePersisted(Variable), {
	valueProperty: 'value',
	versionProperty: 'version'
}) {
	db: any
	static dbFolder = 'db'
	static resetAll(clearDb): any {
	}

	static set(id, value, event) {
		return this.is(id, value, event)
	}

	patch(properties) {
		return this.then((value) =>
			when(this.put(value = Object.assign(value ? copy(value) : {}, properties)), () => value))
	}
	put(value, event) {
		return this.constructor.is(this.id, value, event)
	}
	static DB = lmdb
	static syncVersion = 10
}

export default Persisted
export const Persistable = MakePersisted(Transform)
interface PersistedType extends Function {
	otherProcesses: any[]
	instanceSetUpdated(event): any
	updated(event, by): any
	db: any
	updateWithPrevious: boolean
	listeners: Function[]
}

export class Cached extends KeyValued(MakePersisted(Transform), {
	valueProperty: 'cachedValue',
	versionProperty: 'cachedVersion'
}) {
	allowDirectJSON: boolean
	static Sources: any[]
	static fetchAllIds: () => {}[]

	static get(id, mode) {
		let context = currentContext		
		return when(this.whenUpdatedInContext(context), () => {
			let entry = this.getFromDB(id)
			if (entry) {
				if (entry instanceof Invalidated) {
					let oldTransition = this.transitions.get(id)
					//console.log('Running transform on invalidated', id, this.name, this.createHeader(entry[VERSION]), oldTransition)
					let transition = this.runTransform(id, entry[VERSION], false, mode)
					if (oldTransition && oldTransition.abortables) {
						// if it is still in progress, we can abort it and replace the result
						oldTransition.replaceWith = transition.result
						for (let abortable of oldTransition.abortables) {
							abortable()
						}
					}
					this.transitions.set(id, transition)
					return transition.result
				}
				// TODO: copy this to super/Persisted.get
				if (context && context.ifModifiedSince >= this.cachedVersion) {
					return NOT_MODIFIED
				}
				return entry
			}
			let version = getNextVersion()
			let transition = this.runTransform(id, version, true, mode)
			when(transition.result, (result) => {
				if (result !== undefined && !transition.invalidating) {
					let event = new DiscoveredEvent()
					event.triggers = [ INITIALIZATION_SOURCE ]
					event.source = { constructor: this, id }
					event.version = version
					this.instanceSetUpdated(event)
					this.updated(event, {
						id,
						constructor: this
					})
				}
			})
			this.transitions.set(id, transition)
			return transition.result
		})
	}
	static whenValueCommitted: Promise<any>
	static runTransform(id, fromVersion, isNew, mode) {
		let transition = {
			fromVersion,
			abortables: []
		}
		let hasPromises
		let inputData = this.Sources ? this.Sources.map(source => {
			let data = source.get(id, AS_SOURCE)
			if (data && data.then) {
				hasPromises = true
			}
			return data
		}) : []
		try {
			transition.result = when(when(hasPromises ? Promise.all(inputData) : inputData, inputData => {
				if (inputData.length > 0 && inputData[0] === undefined) // first input is undefined, we pass through
					return
				let context = currentContext
				let transformContext = context ? context.newContext() : new RequestContext(null, null)
				transformContext.abortables = transition.abortables
				return transformContext.executeWithin(() => this.prototype.transform.apply({ id }, inputData.map(copy)))
			}), result => {
				if (transition.invalidating) {
					if (transition.replaceWith) {
						console.log('replaceWith')
						return transition.replaceWith
					}
					return result
				} // else normal transform path
				const conditionalHeader = isNew ? null :
						this.createHeader(transition.fromVersion)
				let committed
				//console.log('conditional header for writing transform ' + (result ? 'write' : 'delete'), id, this.name, conditionalHeader)
				if (result === undefined) {
					if (conditionalHeader === null) {
						// already gone, nothing to do
						committed = Promise.resolve(true)
					} else {
						committed = this.db.remove(toBufferKey(id), conditionalHeader)
					}
				} else {
					result = convertToBlocks(result)
					transition.result = result
					let buffer = this.serializeEntryValue(result, transition.fromVersion, typeof mode === 'object')
					committed = this.db.put(toBufferKey(id), buffer, conditionalHeader)
				}
				this.whenValueCommitted = committed
				committed.then((successfulWrite) => {
					if (this.transitions.get(id) === transition && !transition.invalidating)
						this.transitions.delete(id)
					if (!successfulWrite) {
						//console.log('unsuccessful write of transform, data changed, updating', id, this.name, this.db.get(toBufferKey(id)))
						this.updated(new ReloadEntryEvent(), { id })
					}
				})
				return result
			}, (error) => {
				if (error.__CANCEL__) {
					return transition.replaceWith
				}
				if (this.transitions.get(id) === transition && !transition.invalidating)
					this.transitions.delete(id)
				throw error
			})
		} catch (error) {
			if (this.transitions.get(id) === transition && !transition.invalidating)
				this.transitions.delete(id)
			throw error
		}
		return transition
	}

	getValue() {
		return this.constructor.get(this.id)
	}
	is(value, event) {
		// we skip getFromDB and pretend it wasn't in the cache... not clear if
		// that is how we want is() to behave or not
		this.constructor.is(this.id, value, event)
		return this
	}

	static resetAll(clearDb) {
		//console.log('reseting', this.name)
		return Promise.resolve(spawn(function*() {
			let version = this.startVersion = getNextVersion()
			let allIds = yield this.fetchAllIds ? this.fetchAllIds() : []
			if (clearDb) {
				this.clearAllData()
			}// else TODO: if not clearDb, verify that there are no entries; if there are, remove them
			let committed
			for (let id of allIds) {
				if (this.instancesById.get(id)) {
					// instance already in memory
					this.for(id).updated()
					continue
				}
				const version = getNextVersion() // we give each entry its own version so that downstream indices have unique versions to go off of
				committed = this.db.put(toBufferKey(id), this.createHeader(version))
			}
			return committed
			//console.info('Finished reseting', this.name)
		}.bind(this)))
	}

	static writeEntry(id, event, by) {
		const keyAsBuffer = toBufferKey(id)
		let previousEntry
		let previousVersion, previousStatusByte
		if (this.updateWithPrevious) {
			previousEntry = by.previousValue = this.getFromDB(id)
			if (previousEntry) {
				previousVersion = previousEntry[VERSION]
				previousStatusByte = previousEntry[STATUS_BYTE]
			}
		}
		let version = event.version
		let transition = this.transitions.get(id)
		//console.log('writeEntry previous transition', id, this.name, transition)

		if (transition) {
			if (transition.invalidating) {
				previousVersion = transition.newVersion
				previousStatusByte = INVALIDATED_STATE
			} else if (transition.result && transition.result.then) {
				// still resolving but this gives us the immediate version
				previousVersion = transition.fromVersion
				previousStatusByte = INVALIDATED_STATE
			}// else the previousEntry should have correct version and status
			transition.invalidating = true
			transition.newVersion = version
		} else {
			this.transitions.set(id, transition = {
				invalidating: true,
				newVersion: version
			})
		}
		let valueCache = this._valueCache
		if (valueCache) {
			let value = valueCache.get(id)
			if (value !== undefined) {
				expirationStrategy.deleteEntry(value)
				valueCache.delete(id)
			}
		}

		if (this.shouldPersist !== false &&
			!(event && event.sourceProcess && // if it came from another process we can count on it to have written the update, check to make sure it is running against this table
				(this.otherProcesses.includes(event.sourceProcess) || // another process should be able to handle this
					this.otherProcesses.some(otherProcessId => otherProcessId < process.pid) // otherwise, defer to the lowest number process to handle it
				))) {
			// storing as a version alone to indicate invalidation
			let db = this.db
			let written
				//console.log('Invalidating entry', id, this.name, new Date(version/ 256 + 1500000000000), this.createHeader(version))
				let conditionalHeader
			if (event && event.type === 'deleted') {
				// completely empty entry for deleted items
				written = db.remove(keyAsBuffer)
			} else {
				let conditionalHeader = previousVersion && this.createHeader(previousVersion)
				if (conditionalHeader) {
					conditionalHeader[0] = previousStatusByte
				}
				//console.log('conditional header for invaliding entry ', id, this.name, conditionalHeader)
				written = db.put(keyAsBuffer, this.createHeader(version), conditionalHeader)
			}
			
			// TODO: Determine when the writes are submitted and just update this buffer over and over
			let versionBuffer = Buffer.allocUnsafe(8)
			writeUInt(versionBuffer, this.lastVersion = Math.max(this.lastVersion, version))
			db.put(LAST_VERSION_IN_DB_KEY, versionBuffer)
			if (!event.whenWritten)
				event.whenWritten = written
			if (by.previousValue) {
				by.previousValue = written.then((result) => {
					if (result === false) {
//						console.log('Value had changed during invalidation', id, this.name, version)
						this.transitions.delete(id) // need to recreate the transition so when we re-read the value it isn't cached
						let existingBuffer = db.get(keyAsBuffer, NO_COPY_OPTIONS)
						let newVersion = existingBuffer ? readUInt(existingBuffer) : 0
						if (newVersion > version) {
							// don't do anything further, db is ahead of us, and we should take no indexing action
							return new Invalidated(newVersion)
						} else {
							// it was no longer the same as what we read, re-run, as we have a more recent update
							this.writeEntry(id, event, by)
							return by.previousValue
						}
					}
					return previousEntry
				})
			}
			const finished = (result) => {
				//console.log('writeEntry finished with', id, this.name, result)
				if (this.transitions.get(id) === transition && transition.newVersion === version) {
					this.transitions.delete(id)
				}
				this.versionBuffer = null
			}
			written.then(finished, finished)
		}
	}

	static createHeader(version) {
		const buffer = Buffer.allocUnsafe(8)
		writeUInt(buffer, version)
		buffer[0] = INVALIDATED_STATE
		buffer[1] = 0
		return buffer
	}

	static _version: number
	static get version() {
		if (this.Sources) {
			return Math.max(this._version || 1, ...(this.Sources.map(Source => Source.version)))
		} else {
			return this._version || 1
		}
	}
	static set version(version) {
		this._version = version
	}
	static returnsAsyncIterables: boolean

	static from(...Sources: Array<Function & {notifies: () => any, for: (id: any) => any, returnsAsyncIterables: boolean}>) {
		if (!Sources[0]) {
			throw new Error('No source provided')
		}
		class CachedFrom extends this {
			constructor(id) {
				super(id)
				for (let i = 0; i < Sources.length; i++) {
					this['source' + (i ? i : '')] = Sources[i].for(id)
				}
			}
			get checkSourceVersions() {
				return false
			}
		}
		for (let Source of Sources) {
			if (Source.returnsAsyncIterables) {
				this.returnsAsyncIterables
			}
		}
		CachedFrom.Sources = Sources
		return CachedFrom
	}

	static getInstanceIds(range) {
		if (!this.fetchAllIds && this.Sources && this.Sources[0] && this.Sources[0].getInstanceIds) {
			// if we don't know if we have all our ids, our source is a more reliable source of instance ids
			return this.Sources[0].getInstanceIds(range)
		}
		return super.getInstanceIds(range)
	}

	static initializeData() {
		console.log('initializeData', this.name)
		const initialized = super.initializeData()
		return when(initialized, () => {
			let receivedPendingVersion = []
			let isFullReset
			let clearDb
			for (let Source of this.Sources || []) {
				let lastVersion = this.lastVersion

				receivedPendingVersion.push(Source.getInstanceIdsAndVersionsSince && Source.getInstanceIdsAndVersionsSince(lastVersion).then(ids => {
					console.log('getInstanceIdsAndVersionsSince',lastVersion, 'for', this.name, ids.length)
					let min = Infinity
					let max = 0
					for (let { id, version } of ids) {
						//min = Math.min(version, min)
						//max = Math.max(version, max)
						let inMemoryInstance = this.instancesById && this.instancesById.get(id)
						if (inMemoryInstance) {
							let event = new ReplacedEvent()
							event.triggers = [ INITIALIZATION_SOURCE ]
							inMemoryInstance.updated(event)
						} else {
							this.db.put(toBufferKey(id), this.createHeader(version))
						}
					}
					//console.log('getInstanceIdsAndVersionsSince min/max for', this.name, min, max)
				}))
			}
			if (receivedPendingVersion.length > 0) {
				return Promise.all(receivedPendingVersion)
			}
		})
	}

	static get whenProcessingComplete() {
		return this.Sources && Promise.all(this.Sources.map(Source => Source.whenProcessingComplete))
	}
}

type PermissionCheck = (source: any, session: any, action: string, args: Array<any>) => boolean | string

type Secured = {
	allow(...permissions: Array<PermissionCheck>): any
}

export function secureAccess<T>(Class: T): T & Secured {
	Class.allow = function(...permissions: Array<PermissionCheck>) {
		let Class = this
		let methodOverrides = {
			for(id) {
				let target = Class.for(id)
				return new Proxy(target, handler)
			},
			stopNotifies(target) {
				// skip permissions on this
				return this.stopNotifies(target)
			},
			isChecked() {
				return true
			}
		}
		let handler = {
			get(target, name) {
				let value = target[name]
				if (methodOverrides[name]) {
					return methodOverrides[name].bind(target)
				}
				if (typeof value === 'function') {
					return function() {
						let context = currentContext
						// create a new derivative context that includes the session, but won't
						// update the version/timestamp
						return context.newContext().executeWithin(() => {
							let awaitingListener, variable, isAsync = false
							const permitted = when(secureAccess.checkPermissions(permissions, target, name, Array.from(arguments)), (permitted) => {
								if (permitted !== true) {
									throw new AccessError('User does not have required permissions: ' + permitted + ' for ' + Class.name)
								}
							})
							const whenPermitted = () =>
								context.executeWithin(() => value.apply(target, arguments))
							if (permitted.then) {
								let result
								let whenFinished = permitted.then(() => {
									result = whenPermitted()
								})
								return {
									then: (onFulfilled, onRejected) =>
										whenFinished.then(() => {
											return onFulfilled(result)
										}, onRejected)
								}
							}
							return whenPermitted()
						})
					}
				} else {
					return value
				}
			}
		}
		return new Proxy(this, handler)
	}
	return Class
}

class DiscoveredEvent extends AddedEvent {
	type
}
DiscoveredEvent.prototype.type = 'discovered'

class ReloadEntryEvent extends ReplacedEvent {
	type
}
ReloadEntryEvent.prototype.type = 'reload-entry'

function convertToBlocks(value) {
	// convert to partitioned blocks
	if (value && typeof value === 'object' && !isBlock(value)) {
		if (value.constructor === Object) {
			var newValue = {}
			for (var key in value) {
				var subValue = value[key]
				if (subValue && typeof subValue === 'object') {
					newValue[key] = asBlock(subValue)
				} else {
					newValue[key] = subValue
				}
			}
			return asBlock(newValue)
		}
	}
	return value

}
secureAccess.checkPermissions = () => true
import { Reduced } from './Reduced'

let clearOnStart
export function configure(options) {
	Persisted.dbFolder = options.dbFolder
	Cached.dbFolder = options.cacheDbFolder || options.dbFolder
	Persistable.dbFolder = options.cacheDbFolder || options.dbFolder
	globalDoesInitialization = options.doesInitialization
	clearOnStart = options.clearOnStart
}

// write a 64-bit uint (could be optimized/improved)
function writeUInt(buffer, number, offset?) {
	buffer.writeUIntBE(number, (offset || 0) + 2, 6)
}
// read a 64-bit uint (could be optimized/improved)
function readUInt(buffer, offset?) {
	return buffer.readUIntBE((offset || 0) + 2, 6)
}

export class Invalidated {
	constructor(version) {
		this[VERSION] = version
	}
	[VERSION]: number
}
Invalidated.prototype[STATUS_BYTE] = INVALIDATED_STATE
