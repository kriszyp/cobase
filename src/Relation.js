export const Relation = ({ From, To, joinOn, joinName }) => {
	class Joined extends Index({ Source: From }) {
		static indexBy(from) {
			return joinOn(from)
		}
	}
	return {
		get From() {
			return FromJoined || (FromJoined = (() => {
				class FromJoined extends Cached(From) {
					transform(from) {
						let fromCopy = Object.assign({}, from)
						fromCopy[reverseName] = To.for(joinOn(from)).valueOf()
						return fromCopy
					}
				}
				To.notifies({
					updated(event, by) {
						Joined.from(by.id).forEach(fromId => {
							FromJoined.for(fromId).updated(event)
						})
					}
				})
				return FromJoined
			})())
		}
		get To() {
			return ToJoined || (ToJoined = class extends Cached(To, Joined) {
				transform(to, joined) {
					let toCopy = Object.assign({}, to)
					toCopy[joinName] = joined
					return toCopy
				}
			})
		}
	}
}
