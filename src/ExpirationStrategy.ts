// a prioritized least recently used cache replacement/expiration strategy
// this is implemented as a probablistic multi-step descent towards expiration, with prioritized
// entry positions into the queue (allows repeatedly accessed, smaller objects
// to expire slower)

// number of entries in the cache. reduce this to reduce cache size (less memory)
let CACHE_ENTRIES = 20000
// this is the mid-point size in the cache (roughly half of cache entries will
// be smaller, half larger). Reduce this to force large entries out faster (less memory)
const NOMINAL_SIZE = 100
// this is the speed of decay towards expiration. Reducing this will result in
// more "accurate" expiration timing, but will also increase the overhead of the
// algorithm
const DECAY_RATE = 2.7

const DECAY_INTERVAL = 10000
const DECAY_REMOVAL = 10
const PRIORITY = Symbol('priority')
const EMPTY_SLOT = {
  set [PRIORITY](priority) {
  },
  get [PRIORITY]() {
    return -1
  },
}

let offset = 0 // starting offset, shouldn't need to adjust
class ExpirationStrategy {
	cache = []

	constructor() {
		// periodically clean out entries so they decay over time as well.
		setInterval(() => {
			for (let i = 0; i < DECAY_REMOVAL; i++) {
				this.useEntry(EMPTY_SLOT, Math.random())
			}
		}, DECAY_INTERVAL).unref()
	}

	useEntry(entity, size) {
		if (!isFinite(size)) {
			size = 100
		}
		let lastPriority = entity[PRIORITY]
		if (lastPriority > -1) {
			// remove from old slot if it is currently in cache
			this.cache[entity[PRIORITY]] = null
		}
		// define new priority
		// to prevent duplicate sizes from colliding, we add a revolving offset
		// this is an 8-bit revolving offset. We could add more bits if we wanted
		// to further reduce collisions, but minimizing offset bits actually helps leave "room"
		// for multi-occurence entries to stick around longer, and more offset bits could cause overlaps
		// in sizes which slightly reduces accuracies
		// offset = (offset + 157) & 255
		// calculate new priority/slot, placing large entries closer to expiration, smaller objects further from expiration
		let adjustedSize = size / NOMINAL_SIZE
		let priority = entity[PRIORITY] = Math.floor(CACHE_ENTRIES / (1 +
			(lastPriority > -1 ?
				(adjustedSize + CACHE_ENTRIES / lastPriority) / 3 :
				adjustedSize)))
		while(entity) {
			// iteratively place entries in cache, pushing old entries closer to the end of the queue
			priority = entity[PRIORITY] = Math.floor(priority / DECAY_RATE)
			if (priority == -1) {
				return
			}
			let entityToMove = this.cache[priority]
			this.cache[priority] = entity
			entity = entityToMove
			if (priority == 0 && entity) {
				// moved out of the queue, clear it from the cache
				entity[PRIORITY] = -1 // keep priority a number type for more efficient class structure
				return
			}
		}
	}
	deleteEntry(entity) {
		if (entity[PRIORITY] > -1) {
			// remove from old slot if it is currently in cache
			this.cache[entity[PRIORITY]] = null
		}
	}
	isCached(entity) {
		return entity[PRIORITY] > -1
	}
	getSnapshot() {
		let totalSize = 0
		let size
		return {
			entries: this.cache.map(entity => entity && ({
				id: entity.id,
				type: entity.constructor.name,
				size: (size = entity.approximateSize, (totalSize += (size || 1000)), size)
			})),
			totalSize
		}
	}
	set cachedEntrySize(size) {
		CACHE_ENTRIES = size
	}
	get cachedEntrySize() {
		return CACHE_ENTRIES
	}
	clearEntireCache() {
		// clear the entire cache. This is useful for finding memory leaks
		for (let i in this.cache) {
			let entry = this.cache[i]
			if (entry) {
				this.cache[i] = null
			}
		}
	}
	static defaultInstance = new ExpirationStrategy()
}
export default ExpirationStrategy

/*
This is the test I used to determine the optimal multiplier for spatial diversity:
for (var multiplier = 0; multiplier < 255; multiplier++) {
	entries = []
	sum = 0
	for (var i = 0; i < 256; i++) {
		let n = ((i * multiplier) & 255)
		for (var j = 0; j < 128; j++) {
			if (entries[(n - j + 256) & 255] || entries[(n + j + 256) & 255]) {
				sum += j
				//console.log(j)
				break
			}
		}
		entries[n] = true
	}
	if (sum > 800) {
		console.log(multiplier, sum)
	}
}
*/