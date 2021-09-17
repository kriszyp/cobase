// this provides a weak-valued map to ensure we only have a single instance of an object per id, but can still be GC-ed
export let WeakValueMap
try {
	const { WeakLRUCache } = await import('weak-lru-cache')
	let allInstances = []
	WeakValueMap = function() {
		let map = new WeakLRUCache({
			expirer: false,
		})
		allInstances.push(map)
		return map
	}
	WeakValueMap.getStatus = function() {
		let mapStats = []
		for (let map of allInstances) {
			let size = 0
			let count = 0
			for (let key of map.keys()) {
				let value = map.get(key)
				size += value && value.approximateSize || 100
				count++
			}
			if (count > 0) {
				mapStats.push({
					name: map.name,
					size,
					count
				})
			}
		}
		return mapStats
	}
} catch (error) {
	console.warn('No weak value map available, this can be used for development, but weak value maps should be enabled for production use', error.toString())
	WeakValueMap = Map
	WeakValueMap.getStatus = function() {
		return 'WeakValueMap failed to load'
	}
	WeakValueMap.prototype._keysAsArray = function() {
		return Array.from(this.keys())
	}
}
