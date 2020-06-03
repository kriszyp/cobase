import { Cached } from './Persisted'

export class Aggregator extends Cached {
	static updateAggregate(id, indexRequest) {
	}
	static forValue(id, value, indexRequest) {
		indexRequest.value = value
		return this.tryForQueueEntry(id, () => this.updateAggregate(id, indexRequest))
	}
	static forQueueEntry(id) {
		return this.tryForQueueEntry(id, () =>
			this.updateAggregate(id).then(complete => {
				if (complete) {
					complete.commit()
				}
			})
		)
	}
	static openDatabase() {
		return Source.openChildDB(this, true)
	}
	static getIdsFromKey(key) {
		return Source.getIdsFromKey(key)
	}
	static updateDBVersion() {
		if (!Source.wasReset) // only reindex if the source didn't do it for use
			this.db.putSync(INITIALIZING_LAST_KEY, this.resumeFromKey = Buffer.from([1, 255]))
		super.updateDBVersion()
	}

	static resumeQueue() {
		this.state = 'waiting for upstream source to build'
		// explicitly wait for source to finish resuming before our own resuming
		return when(Source.resumePromise, () =>
			super.resumeQueue())
	}

	static updated(event, by) {
		// don't do anything, we don't want these events to propagate through here, and we do indexing based on upstream queue
	}
}
