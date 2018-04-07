import ArrayLikeIterable from '../util/ArrayLikeIterable'

export interface Database {
	getSync(id, asBuffer?): any
	get(id): Promise<any>
	putSync(id, value): void
	put(id, value): Promise<void>
	removeSync(id): void
	remove(id): Promise<void>
	iterable(options: IterableOptions): ArrayLikeIterable
	batch(operations: OperationsArray): Promise<void>
	close(): Promise<void>
	clear(): Promise<void>
}
export interface IterableOptions {
	gt?: any
	gte?: any
	lt?: any
	lte?: any
	values?: boolean
	valueAsBuffer?: boolean
	limit?: number
}
export interface OperationsArray extends Array<{
	type: string
	key: any
	value?: any
}> {
	byteCount?: number
}
