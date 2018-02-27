// a prioritized least recently used cache replacement/expiration strategy
// this is implemented as a probablistic multi-step descent towards expiration, with prioritized
// entry positions into the queue (allows repeatedly accessed, smaller objects
// to expire slower)

// number of entries in the cache. reduce this to reduce cache size (less memory)
const CACHE_ENTRIES = 20000
// this is the mid-point size in the cache (roughly half of cache entries will
// be smaller, half larger). Reduce this to force large entries out faster (less memory)
const NOMINAL_SIZE = 100
// this is the speed of decay towards expiration. Reducing this will result in
// more "accurate" expiration timing, but will also increase the overhead of the
// algorithm
const DECAY_RATE = 1.7
let offset = 0 // starting offset, shouldn't need to adjust
class ExpirationStrategy {
	cache = []

	useEntry(entity, size) {
		if (!isFinite(size)) {
			size = 100
		}
		if (entity.priority > -1) {
			// remove from old slot if it is currently in cache
			this.cache[entity.priority] = null
		}
		// define new priority
		let lastPriority = entity.priority
		// to prevent duplicate sizes from colliding, we add a revolving offset
		// this is an 8-bit revolving offset. We could add more bits if we wanted
		// to further reduce collisions, but minimizing offset bits actually helps leave "room"
		// for multi-occurence entries to stick around longer, and more offset bits could cause overlaps
		// in sizes which slightly reduces accuracies
		offset = (offset + 149) & 255
		// calculate new priority/slot, placing large entries closer to expiration, smaller objects further from expiration
		let adjustedSize = size / NOMINAL_SIZE
		entity.priority = Math.floor(CACHE_ENTRIES / (1 +
			(lastPriority > -1 ?
				(adjustedSize + CACHE_ENTRIES / lastPriority) / 3 :
				adjustedSize)))
		while(entity) {
			// iteratively place entries in cache, pushing old entries closer to the end of the queue
			let priority = entity.priority = Math.floor(entity.priority / DECAY_RATE)
			if (priority == -1) {
				return
			}
			let entityToMove = this.cache[priority]
			this.cache[priority] = entity
			entity = entityToMove
			if (priority == 0 && entity) {
				// moved out of the queue, clear it from the cache
				entity.priority = -1 // keep priority a number type for more efficient class structure
				return entity.clearCache()
			}
		}
	}
	deleteEntry(entity) {
		if (entity.priority > -1) {
			// remove from old slot if it is currently in cache
			this.cache[entity.priority] = null
		}
	}
	isCached(entity) {
		return entity.priority > -1
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
	static defaultInstance = new ExpirationStrategy()
}
export default ExpirationStrategy
