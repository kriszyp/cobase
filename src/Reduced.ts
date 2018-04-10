import { Cached } from './Persisted'
import { toBufferKey, fromBufferKey, Metadata } from 'ordered-binary'
import when from './util/when'
const INVALIDATED_VALUE = Buffer.from([])
const SEPARATOR_BYTE = Buffer.from([30]) // record separator control character
const REDUCED_INDEX_PREFIX_BYTE = Buffer.from([3])
const CHILDREN = 2

export class Reduced extends Cached {
	static startingValue = undefined
	/**
	* This defines the reduce function that accumulates index entry values into a single value
	*/
	reduceBy(a, b) {
		return null
	}

	// rewrite the source to be the computed reduced value
	// this allows transform to still execute using the result
	get source() {
		return this.reducingSource || (this.reducingSource = {
			valueOf: this.getReducedEntry.bind(this)
		})
	}

	set source(source) {
		this.indexSource = source
	}

	getReducedEntry() {
		return this.transaction(async (db, put) => {
			if (this.rootLevel > -1) {
				const indexKey = toBufferKey(this.id)
				const { split, noChildren, accumulator } = await this.reduceRange(this.rootLevel, Buffer.from([1]), Buffer.from([255]), put)
				if (split) // splitting the root node, just bump up the level number
					this.rootLevel++
				else if (noChildren) {
					// if all children go away, return to a root level of 1
					// we don't ever incrementally reduce depth, and if we are decreasing children,
					// we can represent a single childen with an arbitrarily deep single-child-at-every-level
					// tree
					this.rootLevel = 1
				}
				// now it should be written to the node
				// this should be done by Cached: Class.dbPut(this.id, version + ',' + this.rootLevel + ',' + JSON.stringify(accumulator))
				return accumulator
			}
		})
	}

	async reduceRange(level, rangeStartKey: Buffer, rangeEndKey: Buffer, put) {
		let iterator
		const Class = this.constructor
		const db = Class.db
		const indexBufferKey = toBufferKey(this.id)
		if (level === 1) {
			// leaf-node, go to source index
			iterator = this.indexSource.getIndexedValues({
				gte: Buffer.concat([indexBufferKey, SEPARATOR_BYTE, rangeStartKey]),
				lt: Buffer.concat([indexBufferKey, SEPARATOR_BYTE, rangeEndKey]),
			}, true)[Symbol.asyncIterator]()
		} else {
			// mid-node, use our own nodes/ranges here
			iterator = db.iterable({
				gt: Buffer.concat([REDUCED_INDEX_PREFIX_BYTE, Buffer.from([level - 1]), indexBufferKey, SEPARATOR_BYTE, rangeStartKey]),
				lt: Buffer.concat([REDUCED_INDEX_PREFIX_BYTE, Buffer.from([level - 1]), indexBufferKey, SEPARATOR_BYTE, rangeEndKey]),
				reverse: false,
			}).map(({ key, value }) => {
				let [, startKey, endKey] = fromBufferKey(key.slice(2), true)
				return {
					level: key[1],
					key: startKey,
					endKey,
					value: value.length > 0 ? JSON.parse(value) : INVALIDATED_VALUE,
				}
			})[Symbol.asyncIterator]()
		}
		let next
		let version = Date.now()
		let firstOfSection = true
		let split = false
		let lastDividingKey = rangeStartKey
		let accumulator
		let totalAccumulator
		let childrenProcessed = 0		// asynchronously iterate
		while(!(next = await iterator.next()).done) {
			let { key, endKey, value } = next.value
			if (value && value.then) // if the index has references to variables, need to resolve them
				value = await value

			childrenProcessed++
			if (childrenProcessed > CHILDREN) {
				childrenProcessed = 0
				let nextDividingKey = endKey || key
				put(Buffer.concat([REDUCED_INDEX_PREFIX_BYTE, Buffer.from([level]), indexBufferKey, SEPARATOR_BYTE, lastDividingKey, SEPARATOR_BYTE, lastDividingKey = toBufferKey(nextDividingKey)]),
					JSON.stringify(accumulator))
				if (!split)
					totalAccumulator = accumulator // start with existing accumulation
				else
					totalAccumulator = this.reduceBy(totalAccumulator, accumulator)
				split = true
				firstOfSection = true
			}

			if (value == INVALIDATED_VALUE) {
				const result = await this.reduceRange(level - 1, toBufferKey(key), toBufferKey(endKey), put)
				value = result.accumulator
				put(Buffer.concat([REDUCED_INDEX_PREFIX_BYTE, Buffer.from([level - 1]), indexBufferKey, SEPARATOR_BYTE, toBufferKey(key), SEPARATOR_BYTE, toBufferKey(endKey)]),
					result.split || result.noChildren ?
						undefined :// if it is a split, we have to remove the existing node
						JSON.stringify(value)) // otherwise write our value
				if (result.noChildren) {
					continue
				}
			}
			if (firstOfSection) {
				accumulator = value
			} else {
				accumulator = await this.reduceBy(accumulator, value)
			}
			firstOfSection = false
		}
		// store the last accumulated value if we are splitting
		if (split) {
			put(Buffer.concat([REDUCED_INDEX_PREFIX_BYTE, Buffer.from([level]), indexBufferKey, SEPARATOR_BYTE, lastDividingKey, SEPARATOR_BYTE, rangeEndKey]),
				JSON.stringify(accumulator))
			// do one final merge of the sectional accumulator into the total to determine what to return
			accumulator = await this.reduceBy(totalAccumulator, accumulator)
		}
		return { split, accumulator, version, noChildren: !split && firstOfSection }
	}

	updated(event) {
		for (let source of event.sources) {
			this.invalidateEntry(source.id, event.version)
		}
		if (!this.rootLevel)
			this.rootLevel = 1
		super.updated(event)
	}

	invalidateEntry(sourceKey, version) {
		return this.transaction(async (db, put) => {
			// get the computed entry so we know how many levels we have
			let level = this.rootLevel
			if (!level) {
				let data = await this.constructor.dbGet(this.id, true)
				if (data) {
					let levelSeparatorIndex = data.indexOf(',')
					//let version = data.slice(0, levelSeparatorIndex)
					let dataSeparatorIndex = data.indexOf(',', levelSeparatorIndex + 1)
					level = +data.slice(levelSeparatorIndex + 1, dataSeparatorIndex > -1 ? dataSeparatorIndex : data.length)
				} else {
					return // no entry, no levels
				}
			}
			for (let i = 1; i < level; i++) {
				let sourceKeyBuffer = toBufferKey(sourceKey)
				let [ nodeToInvalidate ] = await db.iterable({
					lt: Buffer.concat([REDUCED_INDEX_PREFIX_BYTE, Buffer.from([i]), toBufferKey(this.id), SEPARATOR_BYTE, sourceKeyBuffer, Buffer.from([255])]),
					values: false,
					reverse: true,
					limit: 1,
				}).asArray
				put(nodeToInvalidate.key, INVALIDATED_VALUE)
			}
			// this should happen in the super.updated call
			//put(this.id, version + ',' + level)
		})
		// rebalancing nodes will take place when we when we do the actual reduce operation
	}
	parseEntryValue(data) {
		if (data) {
			let levelSeparatorIndex = data.indexOf(',')
			let dataSeparatorIndex = data.indexOf(',', levelSeparatorIndex + 1)
			if (dataSeparatorIndex > -1) {
				this.rootLevel = +data.slice(levelSeparatorIndex + 1, dataSeparatorIndex)
				return {
					version: +data.slice(0, levelSeparatorIndex),
					asJSON: data.slice(dataSeparatorIndex + 1)
				}
			} else if (levelSeparatorIndex > -1) {
				this.rootLevel = +data.slice(levelSeparatorIndex + 1)
				return {
					version: +data.slice(0, levelSeparatorIndex),
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
	serializeEntryValue(version, json) {
		return json ? version + ',' + (this.rootLevel || 1) + ',' + json : (version + ',' + (this.rootLevel || 1))
	}
	transaction(action) {
		const Class = this.constructor
		const db = Class.db
		return this.currentTransaction = when(this.currentTransaction, () => {
			let operations = []
			const put = (key, value) => {
				operations.push({
					type: value === undefined ? 'del' : 'put',
					key,
					value
				})
			}
			let result = action(db, put)
			return result.then((result) => {
				return db.batch(operations).then(
					() => {//this.currentTransaction = null
						return result
					},
					(error) => {
						console.error(error)
						//this.currentTransaction = null
						return result
					})
			})
			//return result
		})
	}
}
