import ArrayLikeIterable from '../util/ArrayLikeIterable'

export interface Database {
	getSync(id, asBuffer?): any
	get(id): Promise<any>
	putSync(id, value): void
	put(id, value): void
	removeSync(id): void
	remove(id): void
	iterable(options: IterableOptions): ArrayLikeIterable
	batch(operations: OperationsArray): void
	close(): void
	clear(): void
	transaction(executor: () => void): void
}
export interface IterableOptions {
	start: Buffer,
	end: Buffer,
	values?: boolean
	reverse?: boolean
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
