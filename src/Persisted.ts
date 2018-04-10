import { Transform, VPromise, VArray, Variable, spawn, currentContext, NOT_MODIFIED, getNextVersion, ReplacedEvent, DeletedEvent, AddedEvent, Context } from 'alkali'
import * as level from './storage/level'
import when from './util/when'
import WeakValueMap from './util/WeakValueMap'
import ExpirationStrategy from './ExpirationStrategy'
import * as fs from 'fs'
import * as crypto from 'crypto'
import Index from './KeyIndex'
import { AccessError } from './util/errors'
import { toBufferKey, fromBufferKey } from 'ordered-binary'
import { Database, IterableOptions, OperationsArray } from './storage/Database'

const expirationStrategy = ExpirationStrategy.defaultInstance
const EMPTY_CACHE_ENTRY = {}
const instanceIdsMap = new WeakValueMap()
const DB_VERSION_KEY = Buffer.from([1, 1]) // SOH, code 1
const LAST_VERSION_IN_DB_KEY = Buffer.from([1, 2]) // SOH, code 2
const INITIALIZATION_SOURCE = { isInitializing: true }

export interface ContextWithOptions extends Context {
	preferJSON?: boolean
	ifModifiedSince?: number
}

global.cache = expirationStrategy // help with debugging

class InstanceIds extends Transform.as(VArray) {
	Class: any
	cachedValue: any
	cachedVersion: any
	transform() {
		return when(this.Class.resetProcess, () => this.Class.getInstanceIds())
	}
	valueOf() {
		return when(super.valueOf(true), ids => {
			expirationStrategy.useEntry(this, ids.length)
			return ids
		})
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
	static whenWritten: Promise<{}>
	static db: Database
	db: Database

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

	get checkSourceVersions() {
		// TODO: would like remove this once we have better invalidation of persisted entities
		return false
	}

	get jsonMultiplier() {
		return 1
	}

	get approximateSize() {
		return this.asJSON ? this.asJSON.length * this.jsonMultiplier : 100
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
			this.initialize()
			instancesById = this.instancesById
		}
		let instance = instancesById.get(id)
		if (!instance) {
			instance = new this(id)
			let transform = this.prototype.transform
			if (transform && !transform.hasVersion && this.transformVersion) {
				let transformVersion = this.transformVersion
				if (transformVersion)
					transform.valueOf = function() {
						if (currentContext) {
							currentContext.setVersion(transformVersion)
						}
						return this
					}
				transform.hasVersion = true
				this.prototype.version = Persisted.syncVersion
				console.info('Setting default version to ', this.prototype.version)
			}
			instancesById.set(id, instance)
		}
		return instance
	}

	// Defined as a convenience access to Class.for(id).valueOf()
	static get(id) {
		return this.for(id).valueOf()
	}

	// Defined as a convenience access to Class.for(id).put(value)
	static set(id, value) {
		return this.for(id).put(value)
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

	assignPreviousValue(event) {
		let previousValues = event.previousValues
		if (!previousValues) {
			previousValues = event.previousValues = new Map()
		}
		if (this.readyState === 'up-to-date' && this._cachedValue) {
			return previousValues.set(this, this._cachedValue)
		}
		previousValues.set(this, when(this.loadLocalData(), ({ asJSON }) => {
			// store the old version, for tracking for indices
			return asJSON && JSON.parse(asJSON)
		}))
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
		index.register({ version : 1 })
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
		reduced.register({ version : 1 })
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
		return CachedWith
	}

	transform(source) {
		return source
	}

	get allowDirectJSON() {
		return true
	}


	static updatesRecorded(event) {
		return (event && event.updatesInProgress) ? Promise.all(event.updatesInProgress) : Promise.resolve()
	}

	static get whenFullyReadable() {
		if (this.listeners)
			return Promise.all(this.listeners.map(listener => listener.whenFullyReadable))
		return Promise.resolve()
	}

	delete() {
		return this.constructor.remove(this.id)
	}

	reset(action) {
		this.updated()
	}

	static get ready() {
		return this.hasOwnProperty('_ready') ? this._ready :
			(this._ready = new Promise((resolve, reject) => {
				this.onReady = () => {
					resolve()
				}
				this.onDbFailure = reject
				if (!this.instancesById) {
					this.initialize()
				}
			}))
	}

	static register(sourceCode?: { id?: string, version?: number }) {
		// check the transform hash
		if (sourceCode) {
			let moduleFilename = sourceCode.id || sourceCode
			if (sourceCode.version) {
				// manually provide hash
				this.transformVersion = sourceCode.version
			} else if (typeof moduleFilename == 'string') {
				// create a hash from the module source
				this.transformVersion = fs.statSync(moduleFilename).mtime.getTime()
				let hmac = crypto.createHmac('sha256', 'cobase')
				hmac.update(fs.readFileSync(moduleFilename, { encoding: 'utf8' }))
				this.transformHash = hmac.digest('hex')
			}
		}
		if (!this.instancesById) {
			return this.initialize()
		}
		return this.ready
	}

	static initialize() {
		this.instancesById = new (this.useWeakMap ? WeakValueMap : Map)()
		this.instancesById.name = this.name
		this.ready // make sure the getter is called first
		const db = this.prototype.db = this.db = Persisted.DB.open(this.dbFolder + '/' + this.name)
		// make sure these are inherited
		this.pendingWrites = []
		this.currentWriteBatch = null
		this.whenWritten = null
		clearTimeout(this._registerTimeout)
		if (global[this.name]) {
			throw new Error(this.name + ' already registered')
		}
		global[this.name] = this
		for (let Source of this.Sources || []) {
			Source.notifies(this)
		}
		this.lastVersion = +db.getSync(LAST_VERSION_IN_DB_KEY) || 0
		let stateJSON = db.getSync(DB_VERSION_KEY)
		let didReset
		//console.log('DB starting state', this.name, stateJSON)
		let state = stateJSON && JSON.parse(stateJSON)
		if (state && (state.dbVersion || state.transformHash) == this.transformVersion) {
			this.startVersion = this.version = state.startVersion
		} else {
			console.log('transform/database version mismatch, reseting db table', this.name, state && state.dbVersion, this.transformVersion)
			this.startVersion = this.version = getNextVersion()
			const clearDb = !!state // if there was previous state, clear out all entries
			this.didReset = when(this.resetAll(clearDb), () => when(this.whenWritten, () => this.updateDBVersion()))
		}
		return when(this.didReset, this.onReady, this.onDbFailure)
	}

	static findUntrackedInstances() {
		for (let instance of this.instancesById.values()) {
			if (instance._cachedValue && instance._cachedValue !== EMPTY_CACHE_ENTRY) {
				if (!expirationStrategy.cache.indexOf(instance)) {
					console.log(instance.id, 'is untracked')
				}
			}
		}
	}

	updated(event = new ReplacedEvent(), by?) {
		if (!event.source) {
			event.source = this
		}

		let Class = this.constructor
		if (event.type === 'added') {
			// if we are being notified of ourself being created, ignore it
			this.constructor.instanceSetUpdated(event)
			if (this.readyState) {
				return event
			}
			if (this.cachedVersion > -1) {
				return event
			}
		}
		if (Class.updateWithPrevious) {
			this.assignPreviousValue(event)
		}
		if (by === this) // skip reset
			Variable.prototype.updated.apply(this, arguments)
		else
			super.updated(event, by)
		if (event.type == 'deleted') {
			this.readyState = 'no-local-data'
			this.constructor.instanceSetUpdated(event)
		} else if (by !== this)
			this.resetCache()
		// notify class listeners too
		for (let listener of this.constructor.listeners || []) {
			listener.updated(event, this)
		}

		event.whenWritten = Class.whenWritten // promise for when the update is recorded, this will overwrite any downstream assignment of this property
		return event
	}

	static instanceSetUpdated(event) {
		let instanceIds = instanceIdsMap.get(this.name)
		if (instanceIds) {
			instanceIds.updated(event)
		}
	}

	resetCache() {
	}

	static updated(event, by?) {
		// this should be called by outside classes
		if (event && !event.version) {
			event.version = getNextVersion()
		}
		let instance
		for (let Source of this.Sources || []) {
			if (by && by.constructor === Source) {
				instance = this.for(by.id)
				instance.updated(event, by)
				return event
			}
		}
		if (event && event.type == 'reset' && !this.resetProcess) {
			throw new Error('Deprecated')
		}
		for (let listener of this.listeners || []) {
			listener.updated(event, by)
		}
		return event
	}

	static updateDBVersion() {
		let version = this.startVersion
		this.db.put(DB_VERSION_KEY, JSON.stringify({
			startVersion: version,
			dbVersion: this.transformVersion
		})).then(() => {
			console.log('updated db version', this.name, version, this.transformVersion, this.db.getSync(DB_VERSION_KEY))
		})
		return version
	}

	static notifies(target) {
		// standard variable handling
		return Variable.prototype.notifies.call(this, target)
	}
	static stopNotifies(target) {
		// standard variable handling
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
})

const KeyValued = (Base, { versionProperty, valueProperty }) => class extends Base {

	loadLocalData(now, asBuffer) {
		let Class = this.constructor
		let db = Class.db
		return when(Class.dbGet(this.id, asBuffer), this.parseEntryValue)
	}

	parseEntryValue(data) {
		if (data) {
			let separatorIndex = data.indexOf(',')
			if (separatorIndex > -1) {
				return {
					version: +data.slice(0, separatorIndex),
					asJSON: data.slice(separatorIndex + 1)
				}
			} else if (isFinite(data)) {
				// stored as an invalidated version
				return {
					version: +data
				}
			}
		} else {
			return {}
		}
	}

	loadLatestLocalData() {
		this.readyState = 'loading-local-data'
		return when(this.loadLocalData(false, this.allowDirectJSON), (data) => {
			const { version, asJSON } = data
			if (asJSON) {
				this.readyState = 'up-to-date'
				this.version = Math.max(version, this.version || 0)
				this[versionProperty] = version
				this.asJSON = asJSON
				expirationStrategy.useEntry(this, this.jsonMultiplier * asJSON.length)
			} else if (version) {
				this.version = Math.max(version, this.version || 0)
				this.readyState = 'invalidated'
			} else {
				this.updateVersion()
				this.readyState = 'no-local-data'
			}
			return data
		})
	}

	static getInstanceIds(range: IterableOptions) {
		let db = this.db
		let options: IterableOptions = {
			gt: Buffer.from([4]),
			values: false
		}
		if (range) {
			if (range.gt != null)
				options.gt = toBufferKey(range.gt)
			if (range.lt != null)
				options.lt = toBufferKey(range.lt)
			if (range.gte != null)
				options.gte = toBufferKey(range.gte)
			if (range.lte != null)
				options.lte = toBufferKey(range.lte)
		}
		return when(this.whenWritten, () =>
			db.iterable(options).map(({ key }) => fromBufferKey(key)).asArray)
	}

	static entries(opts) {
		let db = this.db
		return db.iterable({
			gt: Buffer.from([2])
		}).map(({ key, value }) => ({key: fromBufferKey(key), value})).asArray
	}

	/**
	* Iterate through all instances to find instances since the given version
	**/
	static getInstanceIdsAndVersionsSince(sinceVersion: number): { id: number, version: number }[] {
		return this.ready.then(() => {
			let db = this.db
			this.lastVersion = this.lastVersion || +db.getSync(LAST_VERSION_IN_DB_KEY) || 0
			let isFullReset = this.startVersion > sinceVersion
			if (this.lastVersion && this.lastVersion <= sinceVersion && !isFullReset) {
				return []
			}
			console.log('Scanning for updates from', sinceVersion, this.lastVersion, isFullReset, this.name)
			return db.iterable({
				gt: Buffer.from([2])
			}).map(({ key, value }) => {
				const separatorIndex = value.indexOf(',')
				const version = separatorIndex > -1 ? +value.slice(0, separatorIndex) : +value
				return version > sinceVersion ? {
					id: fromBufferKey(key),
					version
				} : null
			}).filter(idAndVersion => {
				return idAndVersion
			}).asArray.then(idsAndVersions => {
				idsAndVersions.sort((a, b) => a.version > b.version ? 1 : -1)
				idsAndVersions.isFullReset = isFullReset
				return idsAndVersions
			})
		})
	}


	static remove(id, event?) {
		if (id > 0 && typeof id === 'string' || !id) {
			throw new Error('Id should be a number or non-numeric string: ' + id)
		}
		event || (event = new DeletedEvent())
		let entity = this.for(id)
		entity.readyState = 'no-local-data'
		event.source = entity
		event.oldValue = when(entity.loadLocalData(), ({ asJSON }) => {
			// store the old version, for tracking for indices
			return asJSON && JSON.parse(asJSON)
		})
		this.instanceSetUpdated(event)
		if (this.updateWithPrevious) {
			entity.assignPreviousValue(event)
		}
		expirationStrategy.deleteEntry(entity)
		this.dbPut(id)
		this.instancesById.delete(id)
		return this.updated(event, entity)
	}

	get [valueProperty]() {
		if (this._cachedValue && this._cachedValue !== EMPTY_CACHE_ENTRY) {
			return this._cachedValue
		}
		return this._cachedValue = when(this.loaded, () => {
			if (this.asJSON) {
				let data = this.asJSON && JSON.parse(this.asJSON.toString('utf8'))
				return this._cachedValue = data
			} else {
				this._cachedValue = undefined
			}
		})
	}

	set [valueProperty](value) {
		this._cachedValue = value
		let newToCache = this.readyState == 'no-local-data'
		if (newToCache) {
			this.readyState = 'loading-local-data'
		}
		let oldJSON = this.asJSON
		if (this.constructor.returnsAsyncIterables) {
			value = when(value, value => {
				let resolutions = []
				function resolveData(data) {
					if (typeof data === 'object' && !(data instanceof Array)) {
						if (data[Symbol.asyncIterator]) {
							let asArray = data.asArray
							if (asArray.then)
								resolutions.push(data.asArray)
						} else {
							for (let key of data) {
								resolveData(data[key])
							}
						}
					}
				}
				resolveData(value)
				if (resolutions.length > 0) {
					return (resolutions.length > 1 ? Promise.all(resolutions) : resolutions[0]).then(() => value)
				}
				return value
			})
		}
		let result = when(value, value => {
			if (!value) {
				if (newToCache) {
					this.readyState = 'no-local-data'
					// object not found, this basically results in a 404, no reason to store or keep anything
					return
				}
				console.warn('Setting empty value', value, 'for', this.id, this.constructor.name)
				this.readyState = 'invalidated'
			}
			let json = this.asJSON = value && JSON.stringify(this._cachedValue = value)
			let result
			if (this.constructor.instancesById.get(this.id) != this) {
				if (this.shouldPersist !== false)
					console.warn('Attempt to set value on non-canonical instance', this.id)
				return
			}
			let Class = this.constructor
			if (this.shouldPersist !== false) {
				let db = Class.db
				let version = this[versionProperty]
				let data = this.serializeEntryValue(version, json)
				Class.dbPut(this.id, data, version) // no need to wait for it, should be synchronously available through the cache
				if (newToCache) {
					// fire an updated, if it is a new object
					let event = new AddedEvent()
					event.version = version
					Class.instanceSetUpdated(event)
					Class.updated(event, this)
				} else if (oldJSON && !oldJSON.then) {
					// if there was old JSON, send updated. Generally this won't be the case
					// as the updated() will record the old JSON and clear it, but if this was invalidated
					// due to version numbers alone, then this will record it.
					//this.constructor.updated(new ReplacedEvent(), this)
				}
			}
			expirationStrategy.useEntry(this, this.jsonMultiplier * (json || '').length)
			return json
		})
		if (result && result.then) {
			// if we are waiting, set the asJSON as the promise
			this.asJSON = result
		}
	}

	serializeEntryValue(version, json) {
		return json ? version + ',' + json : version.toString()
	}

	static dbPut(key, value, version) {
		if (!this.pendingWrites) {
			this.pendingWrites = []
		}
		this.lastVersion = Math.max(this.lastVersion || 0, version || getNextVersion())
		let currentWriteBatch = this.currentWriteBatch
		let whenWritten = this.whenWritten
		if (!currentWriteBatch) {
			currentWriteBatch = this.currentWriteBatch = new Map()
			this.pendingWrites.push(currentWriteBatch)
			currentWriteBatch.writes = 0
			currentWriteBatch.writeSize = 0
			const lastWriteCompletion = whenWritten
			whenWritten = this.whenWritten = new Promise((resolve, reject) => {
				currentWriteBatch.commitOperations = () => {
					currentWriteBatch.commitOperations = () => {} // noop until finished
					clearTimeout(delayedCommit)
					// We are waiting for the last operation to finish before we start the next one
					// not sure if that is the right way to do it, maybe we should allow overlapping commits?
					when(lastWriteCompletion, () => { // always wait for last one to complete
						let operations: OperationsArray = []
						let lastVersion = 0
						for (let [ key, putOperation ] of currentWriteBatch) {
							if (putOperation.version)
								lastVersion = Math.max(lastVersion, putOperation.version)
							operations.push(putOperation)
						}
						// store the current version number
						if (lastVersion > 0)
							operations.push({
								type: 'put',
								key: LAST_VERSION_IN_DB_KEY,
								value: lastVersion
							})
						this.currentWriteBatch = null
						const finished = () => {
							this.pendingWrites.splice(this.pendingWrites.indexOf(currentWriteBatch), 1)
							if (this.whenWritten == whenWritten) {
								this.whenWritten = null
							}

							resolve()
						}
						return this.db.batch(operations).then(finished, (error) => {
							console.error(error)
							finished()
						})
					})
				}
				const delayedCommit = setTimeout(currentWriteBatch.commitOperations, 20)
			})
		}
		currentWriteBatch.set(key, {
			type: value === undefined ? 'del' : 'put',
			key: toBufferKey(key),
			value,
			version
		})
		if (currentWriteBatch.writes++ > 100 || value && (currentWriteBatch.writeSize += (value.length || 10)) > 100000) {
			currentWriteBatch.commitOperations()
		}
		return whenWritten
	}

	static dbGet(key, asBuffer) {
		if (!this.pendingWrites) {
			this.pendingWrites = []
		}
		for (let i = this.pendingWrites.length - 1; i >= 0; --i) {
			let pendingWrite = this.pendingWrites[i]
			if (pendingWrite.has(key)) {
				return pendingWrite.get(key).value
			}
		}
		return this.db[this.isAsync ? 'get': 'getSync'](toBufferKey(key), asBuffer)
	}

	valueOf() {
		let context = currentContext
		if (context && !this.allowDirectJSON && context.ifModifiedSince > -1) {
			context.ifModifiedSince = undefined
		}
		let result = when(when(this.constructor.whenUpdatedInContext(), () =>
			this.readyState || this.loadLatestLocalData()), () => {
			const getValue = () => {
				if (this.cachedVersion > -1 && context && context.preferJSON && this.allowDirectJSON) {
					context.ifModifiedSince = this.cachedVersion
					return when(super.valueOf(true), value =>
						value === NOT_MODIFIED ?
							{ asJSON: this.asJSON } : value)
				}
				return super.valueOf(true)
			}
			if (context && currentContext !== context)
				return context.executeWithin(getValue)
			else
				return getValue()
		})
		return result
	}

	clearCache() {
		this.asJSON = null
		this._cachedValue = undefined
		this.cachedVersion = -1
		if (this.readyState === 'up-to-date' || this.readyState === 'invalidated') {
			this.readyState = undefined
		}
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

	patch(properties) {
		return this.then((value) =>
			when(this.put(value = Object.assign(value || {}, properties)), () => value))
	}
	assignPreviousValue(event) {
		// for Persisted objects, we can use the event.oldValue
		let previousValues = event.previousValues
		if (!previousValues) {
			previousValues = event.previousValues = new Map()
		}
		previousValues.set(this, event.oldValue)
	}
	static DB = level
	static syncVersion = 10
}

Persisted.getSyncStartDb = function() {
	return this.syncStartDb || (this.syncStartDb = Persisted.DB.open('cachedb/sync-start'))
}
Persisted.getSyncVersion = function() {
	return this.getSyncStartDb().get('version').then(version =>
		(version && version <= Date.now()) ?
			this.syncVersion = +version :
			Persisted.newSyncVersion()
	)
}
Persisted.newSyncVersion = function() {
	const newVersion = this.syncVersion = Date.now() // using timestamp versioning
	this.getSyncStartDb().putSync('version', newVersion)
	return newVersion
}

export default Persisted
export const Persistable = MakePersisted(Transform)

export class Cached extends KeyValued(MakePersisted(Transform), {
	valueProperty: 'cachedValue',
	versionProperty: 'cachedVersion'
}) {
	allowDirectJSON: boolean
	static Sources: any[]
	static fetchAllIds: () => {}[]
	is(value, event) {
		// we skip loadLocalData and pretend it wasn't in the cache... not clear if
		// that is how we want is() to behave or not
		event = event || new ReplacedEvent()
		this.updated(event, this)
		this.cachedVersion = this.version
		this.cachedValue = value
		this.readyState = 'up-to-date'
		return this
	}

	static resetAll(clearDb) {
		console.log('reset all for ', this.name)
		return Promise.resolve(spawn(function*() {
			let version = this.startVersion = getNextVersion()
			let allIds = yield this.fetchAllIds ? this.fetchAllIds() : []
			if (clearDb) {
				console.info('Closing the database to clear', this.name)
				let db = this.db
				yield db.clear()
				console.info('Cleared the database', this.name, 'rebuilding')
			}// else TODO: if not clearDb, verify that there are no entries; if there are, remove them
			for (let id of allIds) {
				if (this.instancesById.get(id)) {
					// instance already in memory
					this.for(id).updated()
					continue
				}
				const version = getNextVersion() // we give each entry its own version so that downstream indices have unique versions to go off of
				this.dbPut(id, this.prototype.serializeEntryValue(version), version)
			}
			yield (this.whenWritten)
			console.info('Done reseting', this.name)
		}.bind(this)))
	}

	resetCache(event) {
		this._cachedValue = undefined
		let version = this.version
		if (this.shouldPersist !== false) {
//			if (!this.loaded || this.asJSON || oldJSON) { // maybe this might be a little faster if it is already invalidated
			// storing as a version alone to indicate invalidation
			this.constructor.dbPut(this.id, this.serializeEntryValue(version), version)
//			}
		}
		this.asJSON = undefined
	}

	getTransform() {
		return checkInputTransform
	}

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

	static from(...Sources: Array<Function | {notifies: () => any, for: (id: any) => any}>) {
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

	static register(sourceCode) {
		const registered = super.register(sourceCode)
		when(registered, () => {
			let receivedPendingVersion = []
			for (let Source of this.Sources || []) {
				let lastVersion = this.lastVersion
				receivedPendingVersion.push(Source.getInstanceIdsAndVersionsSince && Source.getInstanceIdsAndVersionsSince(lastVersion).then(ids => {
					if (ids.isFullReset) {
						return when(this.resetAll(lastVersion > 0), // clear the old db if there are any entries
							() => when(this.whenWritten, () => this.updateDBVersion()))
					}
					//console.log('getInstanceIdsAndVersionsSince for', this.name, ids.length)
					let min = Infinity
					let max = 0
					for (let { id, version } of ids) {
						min = Math.min(version, min)
						max = Math.max(version, max)
						let event = new ReplacedEvent()
						event.source = INITIALIZATION_SOURCE
						this.for(id).updated(event)
					}
					//console.log('getInstanceIdsAndVersionsSince min/max for', this.name, min, max)
				}))
			}
		})
		return registered
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
							let awaitingListener, variable
							let result = when(secureAccess.checkPermissions(permissions, target, name, [...arguments]), (permitted) => {
								if (permitted !== true) {
									throw new AccessError('User does not have required permissions: ' + permitted + ' for ' + Class.name)
								}
								return context.executeWithin(() => {
									variable = value.apply(target, arguments)
									if (awaitingListener) {
										variable.notifies(awaitingListener)
									}
									return variable
								})
							})
							// promises get resolved all the way through, so need to proxy notifies calls
							if (result && result.then && !result.notifies) {
								result.notifies = listener => awaitingListener = listener
								result.stopNotifies = listener => variable.stopNotifies(listener)
							}
							return result
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
const checkInputTransform = {
	apply(instance, args) {
		// if the main input is undefined, treat as deleted object and pass on the undefined without running the transform
		if (args[0] === undefined && args.length > 0) {
			return
		}
		return instance.transform.apply(instance, args)
	}
}
secureAccess.checkPermissions = () => true
import { Reduced } from './Reduced'
