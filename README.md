<img src="./assets/alkali-logo.svg?sanitize=true" alt="Alkali" width="100" align="right" />
Cobase is a composable layered system of JavaScript-defined, cached, persisted data transform functions and aggregations for building fast, efficient JavaScript-mapped relational data storage. Cobase is a reactive cache using Alkali's reactive API for entities. Cobase uses four basic data functional/processing constructs to build scalable relational data caches that can be used to query/access data efficiently to scale:

* Join
* Map
* Index
* Reduce

<a href="https://dev.doctorevidence.com/"><img src="./assets/powers-dre.png" width="203" align="right" /></a>
From these constructs we can build data structures that can aggregate and index data from multiples tables and be queried in fast, scalable O(log n) time/space.

There are several key goals and philosophies that have shaped cobase:
* REST-oriented programming architecture that composes data stores by caching layering stores with a uniform interface, ideal for using as a caching/transformation middle tier to put in front of a simple backend storage.
* NoSQL/Document-based DB-functionality with relational capability.
* Scalable, performant data querying is acheived by ensuring data has been properly indexed to quickly satisfy queries, and data indexing and transformation, with full JS functionality, as the central focus of the API design.
* Defaulting to in-process data store access (via LevelDB) for extremely efficient/fast access to indexed/transformed data.

## Getting Started
First, install:

```sh
npm install cobase
```

And then we can begin creating basic persisted data structures. A basic table or data store can be constructed by simply creating a class that extends `Persisted`:

```js
import { Persisted } from 'cobase'
class Project extends Persisted {

}
```

And then we can begin adding data to it.

```js
let newProject = Project.add({ name: 'Learn cobase', description: '...' })
```

The most common API for interacting with your persisted class instances, is to to get an instance for a given id/key, and then we can change it, or retrieve its value:

```js
Project.for(1).valueOf() -> return project with id of 1
// or shorthand:
Project.get(1)
```

Generally stores will return asynchronously, returning a promise to the data requested.

We can then build various layers of transform that use this as our data source. We could also define our base data source from an external data source (SQL database, S3 storage, etc.), and much of Cobase is optimized around this type of architecture, but here we are using our own internal storage for the sake of examples.

## Composing Layers
### Map Transform
The first two compositional functions are available by defining a transforming and caching store, by extending `Cached`. This directly maps and transforms a source data store to the transformed and cached data. For example, if we wanted to select some properties from data source and cache them, we could do:

```js
import { Cached } from 'cobase'
class ProjectSummary extends Cached.from(Project) {
	transform(project) {
		// transforms projects from the source data
		return { // just keep the name
			name: project.name
		}
	}
	static transformVersion = 1 // we can assign a version so that we can increment it to indicate changes in the transform
}
```

The resulting data store will lazily compute and cache these transformed summary objects, providing fast access on repeated accesses.

When defining a transform/cached entry, you should specify a version number in the `register` method that should be incremented whenever the transform is changed so that the table can be recomputed when it changes.

### Join
The compositional aggregation functionality is a join, which is acheived by simply providing multiple data sources to the  `Cached` base class. We can provide multiple data sources, which are then combined by id, and passed into the `transform` function.

```js
import { Cached } from 'cobase'
class ProjectSummary extends Cached.from(Project, ExtraProjectInfo) {
	transform(project, extraProjectInfo) {
		// transforms projects from the source data
		return { // just keep the name
			name: project.name,
			extraInfo: extraProjectInfo
		}
	}
}
```

This allows you to compose a new table of data that is joined from two other tables. This can be used for a variety of situations, although generally, a join is most useful when it is combined with an index/map function that can index by a foreign key to relate two different data sources.

### Index
The third function is an indexing function, that allows one key-valued data source to be mapped to a generated different set of key-values, by different keys. And index is created by extending `Indexed` class, and defining a `static` `indexBy` method (make sure you define it as a `static`!) Imagine we have another store that held a table of tasks, that each had a `projectId` that referenced a project that it belonged to. We can index the tasks store by project id:

```js
import { Indexed } from 'cobase'
class TasksByProject extends Indexed({ Source: Task }) {
	static indexBy(task) { // make sure you define this with static
		return task.projectId // this will index tasks by project ids
	}
}
```

We now have created an index of tasks by the project id. We can join this to the project store to create relationally connected transformed store of cached data:

```js
class ProjectWithTasks extends Cached.from(Project, TasksByProject) {
	transform(project, tasks) {
		return {
			name: project.name,
			tasks
		}
	}
}
```

This is also fully reactive index; any changes to a project, or tasks will automatically update through the layers of the index and caches such `ProjectWithTasks` will be up-to-date.

When `indexBy` simple returns a key, the index will default to generate a store where values comes from the source values. That means that in this case, the indexed key will be the project id, and the value will be the array of tasks with that project id. However, `indexBy` supports a number of different ways to specify keys *and* values. First, `indexBy` can return multiple keys (rather than just a single key in the example above). This can be done by simply returning an array of keys.

We can also specify the values in the indexed table as well. Again, if no value is specified, it will default to the input data source (and will be stored as a reference for efficiency). However, we can specify both the key and value by simply returning an object with `key` and `value` properties. And furthermore, if we want multiple keys and values generated, we can return an array of objects with `key`/`value` properties.

For example:

```js
static indexBy(task) {
	return task.projectIds.map(projectId => ({ // if this was a many to many relationship, with multiple project ids
		key: projectId, // index using the project id as the key
		value: { // if we wanted our index to just store the name and ids of the tasks
			id: task.id,
			name: task.name
		}
	}))
}
static transformVersion = 1 // transform version should be used with an Index as well, to indicate changes to the transform
```

And if we accessed a `ProjectWithTasks` by a project id, this would return a promise to an array of of the task id and name of tasks referencing this project:

```js
ProjectWithTasks.get(projectId)
```

### Reduce
This function provides efficient aggregation of indices, merging multiple values per index key with a reduction operator. Without a reduce function, an index just returns an array of the entries for a given index key, but a reduce function provides a custom function to aggregate values under an index key. The `Reduced` class uses an `Index` class as a source, and aggregates the values of an index entry in `O(log n)` time using a tree/graph reduction algorithm. The `Reduced` class should define a source index, and a `reduceBy(a, b)` method that takes two input values and reduces them to one that it returns. The `Reduced` class extends the `Cached` class and can optionally include a `transform` method to transform the total reduced value.

For example, if we wanted to compute the total estimated time of the tasks in project, this could become very expensive to recompute if there are large number of tasks in a project (`O(n)` after any update). However, a `Reduced` class can maintain this sum with incremental updates in `O(log n)` time.

```js
import { Reduced } from 'cobase'

class ProjectTotalHours extends Reduced.from(TasksByProject) {
	reduceBy(taskA, taskB) {
		return { // the returned value can be passed into subsequent reduceBy calls, so we make it the same type as the inputs
			hours: taskA.hours + taskB.hours
		}
	}
	transform(total) {
		// now finally get just the hours
		return total.hours
	}
}
ProjectTotalHours.for(projectId).valueOf() -> get the total hours of the tasks for a project
```

Note that the `reduceBy` function is slightly different than a JavaScript `reduce` function in that both the inputs may be the output from previous `reduceBy` calls. A `reduceBy` operation must be side-effect free, commutative (order of execution can be rearranged), associative (grouping of execution can rearranged), and referentially transparent (same inputs should always produce same output).

A reduce operation can also be written shorthand from a source entity:

```js
const ProjectTotalHours = TasksByProject.reduce((a, b) => ({ number: a.number + b.number }))
```

## Relational Properties
The relational property definitions provide a convenient mechanism for defining related entities, that is built on cobase's index and join functionality. A derived entity, that is transformed/cached from a source entity can be created with the `cacheWith` method, with property definitions that reference other entities. These referencing property relations are defined by the `relatedBy` and `relatesBy` methods. The appropriate index will be created based on the provided foreign key, to join the indices and produce a cached entity based on the joined data. For example, if we had a `Task` and `Project` entity classes, where the `Task` class had a foreign key referencing projects in the `projectId` property, we could create a `ProjectWithTasks` class that included a project and all its associated tasks:

```js
class ProjectWithTasks extends Project.cacheWith({
	tasks: Task.relatesBy('projectId')
}) {

}
```

Likewise we could define a `TaskWithProject` that defined an entity with the task and the project data it is associated with:

```js
export class TaskWithProject extends Task.cacheWith({
	project: Project.relatedBy('projectId')
})
```

Note the distinct use of the relation definitions:
`TargetEntity.relatesBy(foreignKey)` - This defines a relationship where the foreign key is defined on the `TargetEntity` that will be included as a property. This will add a property with an array of the target entities that reference the parent entity.
`TargetEntity.relatedBy(foreignKey)` - This defines a relationship where the foreign key is defined on source class with a property that will be referencing the `TargetEntity`. This will add a property with a single target entity if there is a single foreign key, or an array of the target entities if the foreign key is an array of ids.

In both cases, the foreign key can be either a single (string or number) value, or an array of values if there is a many-to-many relationship.

## Cobase API

Cobase entities extend the Alkali Variable API, and consequently inherit its full API, as (described here)[https://github.com/kriszyp/alkali#variable-api]. For example, the following are methods available on cobase entity instances:
`valueOf()` - This retrieves the current value of this entity. If this is available synchronously, it will return the value directly. Otherwise, if this requires asynchronous resolution (if the store or transform is async, and it is not cached in memory), it will return a promise to the resolved value.
`then(onFulfilled, onRejected)` - This also retrieves the current of the entity, using the standard promise API/callback. This method also means that all entities can be treated as promises/thenables, and used in places that accept promises, including the `await` operator.
`updated(event?)` - This is can be called to indicate that the entity has been updated, and it's transform needs to be re-executed to retrieve its value.
`subscribe((event) => void)` - Subscribe to a entity and listen for changes.

In addition, the following methods are available as *`static`* methods on entity classes:
`for(id)` - Return the entity for the given id.
`get(id)` - Shorthand for `Entity.for(id).valueof()`.
`set(id, value)` - Shorthand for `Entity.for(id).put(value)`.
`instanceIds` - This property returns a variable array (VArray) with ids of all the available instances of the entity.
`subscribe((event) => void)` - Subscribe to any changes to any instances of this class.
`index(propertyName)` - This returns an `Index` class defined such it indexes this class using the provided property name, or `indexBy` function (that can be referenced by the provided name).

## Connecting to different databases
Cobase, using LevelDB, provides a capable data storage system, and makes it easy to build a compositional data system. However, for many applications, it may be desirable to cobase's compositional transforms on top of an existing database system with transactional capabilities, integrate backup, and/or access to existing/legacy data. In fact, this type of cross-server, compositional data layering where cobase acts a transforming caching middle tier in front of a database, is what cobase is optimized for.

To connect cobase to existing database, we can create a cached class that retrieves data from database as a transform, notifies of changes to data, and delivers any requests for data modifications. Here is an outline of what a connector class looks like that implements a connection to another database:

```js
// we aren't using any other "source" entities, since our transform method will handle retrieving data
class Task extends Cached {
	transform() {
		// this is the main method that is called when an object is first accessed or changed, and can retrieve data from the db
		// this.id has the id of this object
		let id = this.id
		// do a database query to get our data, with something like this (note that we can return a promise, async transforms are fine):
		return sqlDatabase.query('SELECT * FROM TASK WHERE id = $1', [id]).then(rows => {
			// return the first row
			return rows[0]
		})
	}

	static transformVersion = 1 // increment this if we ever change the transform

	static initialize() {
		// we can hook into initialize to do any setup
		// In particular it is important to make sure we notify this class of any data changes.
		// This can be implemented by setting up database trigger, or some other mechanism to
		// notify of data updates.
		// Another simple approach (although not the most efficient/optimal) could be to simply
		// poll for updates:
		let lastUpdate = Date.now()
		sqlDatabase.query('SELECT * FROM TASK WHERE UPDATED > $1', [lastUpdate]).then(rows => {
			lastUpdate = Date.now()
			// for each row that was updated, call updated(),
			// which will mark the entity in cobase as updated
			// and will be re-retrieved on next access
			for (let updatedRow of rows) {
				this.for(updatedRow.id).updated()
			}
		})
		return super.initialize()
	}

	static fetchAllIds() {
		// If you need to be able to be able to get a list of all the object (ids), this can be implemented to fetch them
		return sqlDatabase.query('SELECT id FROM TASK', [lastUpdate]).then(rows.map(row => row.id))
	}
	// alternately you can implement a static resetAll that retrieves all the objects and assigns each with is()

	put() {
		// we could implement methods for updates, if they will go through cobase (updates may go directly to the server)
		return sqlDatabase.execute('INSERT INTO TASK...')
	}
}
```

## Context
### Sessions (Operation Sequencing)
In the cobase composition architecture, when an entity is updated, added, or removed, there may be some delay before any indices or reduce-computations are finished, which typically takes place asynchronously. When you access one of these downstream data sources, normally they will wait for these operations to finish, so they can return data that is consistent with any preceding operations. However, it can be preferable to create separate "sessions" so that when you retrieve data, you don't need to wait for operations to finish that are outside the scope of the current session. This facilitates a type of "eventual consistency" where everything inside the session maintains true consistency, but performance of accessing data is prioritized over waiting for other sessions' operations to be finish. This provides better performance. A session can be used to create a context, which can then be executed around value retrievals or updates:

```js
import { Context } from 'alkali'
let mySession = {}
new Context(mySession).executeWithin(() => {
	someTask.updated()
	TasksByProject.valueOf() // will wait for any changes from the sameTask update to be indexed, but not any operations outside this session
})
```

Without specifying a session, all operations will be performed (and sequenced) within a single default session.

## Memory Model
Cobase ensures a direct one-to-one mapping between a entity id/key and entity object instance. This effectively means multiple calls to get an instance by id will never return a different object or copy of the data:

```js
Task.for(3) === Task.for(3) // always true
```

This protects against data inconsistency between two different instances of the same data, and greatly simplifies the logic of dealing with mapped objects.

Cobase actually integrates with garbage collection (using weak value maps), to allow unused/unreferenced to objects to be collected (so cobase doesn't leak memory after data is accessed), which means object instances can be collected, but still guarantees that at most only one instance of object per id/key is ever in memory at a time.

Cobase uses a size-prioritized, multi-step exponential decaying least frequently/recently used policy to keep recently and frequented used data in memory, to effectively provide a GC-coordinated cache of data in memory, using the object instances. The amount of memory used for keeping recently used object instances in memory can be adjusted by setting the `ExpirationStrategy.cachedEntrySize`. The default value of 20000 keeps up to 20000 entries in memory:

```js
ExpirationStrategy.cachedEntrySize = 40000 // use twice the default amount of caching
```

The weak value map mechanism and LRU caching strategy are described in [more detail here](https://dev.doctorevidence.com/an-introduction-to-weak-value-maps-40e108b44e1c).

## Integration with an HTTP/Web Server
Cobase provides utilities for efficient delivery of data in a web server. This mainly includes a middleware component (built on Koa) that can perform content negotiation and efficiently stream JSON with support for advanced optimizations including direct binary transfer from the DB to streams, and backpressure. The can be used by including the cobase's `media` export as middleware, and then downstream apps/middleware can access `connection.request.data` for the parsed request data, and the response data can be set on `connection.response.data`, and the middleware will serialize to the appropriate content type as specified by the client (defaulting to JSON).

Additional content/media handlers can be defined by using the exported `mediaTypes` `Map`, and setting a media handler with the content type as the key, and an object with `serialize` and/or `parse` methods as the value:

```js
import { mediaTypes, media } from 'cobase'
mediaTypes.set('text/html', {
	serialize(data, connection) {
		return // some HTML we generate from data
	},
	parse(html) {
		// probably wouldn't try to parse HTML from a request, but if we wanted to
	}
})

koaApp.use(media)
```
