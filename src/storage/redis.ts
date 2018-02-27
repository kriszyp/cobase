import * as redis from 'redis'
const client = redis.createClient({url: 'redis://pFw0Zm5Z+MsvcKfoqp2r3lOd:Wl3kimoV3nZ8L+qs3g=@uswe-redis.redis.cache.windows.net:6380?ssl=True'})

export * from {
	get(db, id) {
		return new Promise((resolve, reject) => {
			client.get(db.id + '~' + id, (err, value) => {
				if (err) {
					console.error('error', err)
					reject(err)
				} else {
					resolve(value)
				}
			})
		})
	},
	put(db, id, value) {
		return new Promise((resolve, reject) => {
			client.set(db.id + '~' + id, value, (err, value) => {
				if (err) {
					console.error('error', err)
					reject(err)
				} else {
					resolve(value)
				}
			})
		})
	},
	open(name) {
		return {
			id: name
		}
	}
}
