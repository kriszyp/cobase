export class ExtendableError extends Error {
	constructor(message) {
		super(message)
		this.stack = (new Error()).stack
		this.name = this.constructor.name
	}
}
export class ShareChangeError extends Error {}

export class AccessError extends ExtendableError {
	get status() {
		return 403
	}
	get isExternal() {
		return true
	}
}

export class UnauthenticatedError extends ExtendableError {
	get status() {
		return 401
	}
	get isExternal() {
		return true
	}
}
export class ConcurrentModificationError extends ExtendableError {
}
