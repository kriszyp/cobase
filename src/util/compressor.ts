import { compress, uncompress, uncompressSync } from 'snappy'
import when from './when'

export const ACTIVE_STATUS = 0
export const STANDBY_STATUS = 2
export const COMPRESSING_STATUS = 3
export const COMPRESSED_STATUS = 4
export const UNCOMPRESSING_STATUS = 5
const COMPRESSION_THRESHOLD = 2048
export async function runCompression(db) {
	let iterator = db.iterable({ start: Buffer.from([2]) })
	for (let { key, value } of iterator) {
		if (value.length <= COMPRESSION_THRESHOLD)
			continue
		let header = value.slice(0, 8)
		let firstByte = value[0]
		if (firstByte === 0) {
			// active, mark as inactive
			header[0] = STANDBY_STATUS
		} else if (firstByte === STANDBY_STATUS || firstByte === COMPRESSING_STATUS) {
			header[0] = COMPRESSING_STATUS
			// TODO: check to make sure other bits haven't changed
			compress(value.slice(8), function(error, compressed) {
				if (error) {
					header[0] = STANDBY_STATUS
					return console.error(error)
				}
				header[0] = COMPRESSED_STATUS
				db.transaction(() => {
					db.put(key, Buffer.concat([header, compressed]))
				})
			})
		}
	}
}

export function uncompressEntry(db, key, compressedValue, callback) {
//	return new Promise((resolve, reject) => {
		compressedValue[0] = UNCOMPRESSING_STATUS
		let header = compressedValue.slice(0, 8)
		return when(uncompressSync(compressedValue.slice(8)), (value) => {
//			resolve(value)
			header[0] = 0
			let newBuffer = Buffer.concat([header, value])
			db.transaction(() => {
				db.put(key, newBuffer)
			})
			return newBuffer
		})
//	})
}
export function compressEntry(db, key, value) {
	if (value.length > COMPRESSION_THRESHOLD) {
		value[0] = COMPRESSING_STATUS
//		db.put(key, value) // put this uncompressed value in so there is immediate consistency
		let header = value.slice(0, 8)
		compress(value.slice(8), (error, compressedValue) => {
			header[0] = COMPRESSED_STATUS
			// asynchronous compression and put, typically this will occur before the batch transaction starts
			db.put(key, Buffer.concat([header, compressedValue]))
		})
	} else {
		return db.put(key, value)
	}
}
