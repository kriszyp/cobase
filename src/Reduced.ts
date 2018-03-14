import { Cached } from './Persisted'
import { toBufferKey, fromBufferKey, Metadata } from 'ordered-binary'
import when from './util/when'
const INVALIDATED_VALUE = Buffer.from([1, 3])
const SEPARATOR_BYTE = Buffer.from([30]) // record separator control character
const REDUCED_INDEX_PREFIX_BYTE = Buffer.from([3])
const CHILDREN = 2

export class Reduced extends Cached {
	static startingValue = undefined
	/**
	* This defines the reduce function that accumulates index entry values into a single value
	*/
	reduceBy(accumulator, nextValue) {
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
				const { split, accumulator } = await this.reduceRange(this.rootLevel, Buffer.from([0]), Buffer.from([255]), put)
				if (split) // splitting the root node, just bump up the level number
					this.rootLevel++
				// now it should be written to the node
				// this should be done by Cached: Class.dbPut(this.id, version + ',' + this.rootLevel + ',' + JSON.stringify(accumulator))
				return accumulator
			}
		})
	}

	async reduceRange(level, rangeStartKey: Buffer, rangeEndKey: Buffer, put) {
		let iterator
		const Class = this.constructor
		const db = Class.getDb()
		const indexBufferKey = toBufferKey(this.id)
		if (level === 1) {
			// leaf-node, go to source index
			iterator = this.indexSource.getIndexedValues({
				gt: Buffer.concat([indexBufferKey, SEPARATOR_BYTE, rangeStartKey]),
				lt: Buffer.concat([indexBufferKey, SEPARATOR_BYTE, rangeEndKey]),
			}, true)[Symbol.asyncIterator]()
		} else {
			// mid-node, use our own nodes/ranges here
			iterator = db.iterable({
				gt: Buffer.concat([REDUCED_INDEX_PREFIX_BYTE, Buffer.from([level - 1]), indexBufferKey, SEPARATOR_BYTE, rangeStartKey]),
				lt: Buffer.concat([REDUCED_INDEX_PREFIX_BYTE, Buffer.from([level - 1]), indexBufferKey, SEPARATOR_BYTE, rangeEndKey]),
			}).map(({ key, value }) => {
				let [, startKey, endKey] = fromBufferKey(key.slice(2), true)
				return {
					level: key[1],
					key: startKey,
					endKey,
					value: JSON.stringify(value),
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
		let childrenProcessed = 0
		// asynchronously iterate
		while(!(next = await iterator.next()).done) {
			let { key, endKey, value } = next.value

			childrenProcessed++
			if (childrenProcessed > CHILDREN) {
				childrenProcessed = 0
				let nextDividingKey = endKey || key
				put(Buffer.concat([REDUCED_INDEX_PREFIX_BYTE, Buffer.from([level - 1]), indexBufferKey, SEPARATOR_BYTE, lastDividingKey, SEPARATOR_BYTE, lastDividingKey = toBufferKey(nextDividingKey)]),
					JSON.stringify(accumulator))
				if (!split)
					totalAccumulator = accumulator // start with existing accumulation
				else
					totalAccumulator = this.reduceBy(totalAccumulator, accumulator)
				split = true
				firstOfSection = true
			}

			if (value == INVALIDATED_VALUE) {
				const result = await this.reduceRange(level - 1, key, endKey, put)
				value = result.accumulator
				put(Buffer.concat([REDUCED_INDEX_PREFIX_BYTE, Buffer.from([level - 1]), indexBufferKey, SEPARATOR_BYTE, rangeStartKey, SEPARATOR_BYTE, rangeEndKey]),
					split ? undefined : JSON.stringify(value))
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
			// do one final merge of the sectional accumulator into the total
			accumulator = await this.reduceBy(totalAccumulator, accumulator)
			put(Buffer.concat([REDUCED_INDEX_PREFIX_BYTE, Buffer.from([level - 1]), indexBufferKey, SEPARATOR_BYTE, rangeStartKey, SEPARATOR_BYTE, rangeEndKey]),
				JSON.stringify(accumulator))
		}
		return { split, accumulator, version }
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
			let data = await db.get(this.id)
			let level = 1
			if (data) {
				let levelSeparatorIndex = data.indexOf(',')
				//let version = data.slice(0, levelSeparatorIndex)
				let dataSeparatorIndex = data.indexOf(',', levelSeparatorIndex + 1)
				level = +data.slice(levelSeparatorIndex + 1, dataSeparatorIndex > -1 ? dataSeparatorIndex : data.length)
			}
			for (let i = 1; i < level; i++) {
				let sourceKeyBuffer = toBufferKey(sourceKey)
				let [ nodeToInvalidate ] = await db.iterable({
					lt: Buffer.concat([REDUCED_INDEX_PREFIX_BYTE, Buffer.from([level]), toBufferKey(this.id), SEPARATOR_BYTE, sourceKeyBuffer, Buffer.from([255])]),
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
		const db = Class.getDb()
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
			return result.then((result) =>
				db.batch(operations).then(
					() => {//this.currentTransaction = null
						return result
					},
					(error) => {
						console.error(error)
						//this.currentTransaction = null
						return result
					}))
			//return result
		})
	}
}
