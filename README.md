<img src="./assets/alkali-logo.svg?sanitize=true" alt="Alkali" width="100" align="right" />

Cobase is composable layered system of JavaScript defined data transform functions and aggregations for building fast, efficient JavaScript-mapped relational data storage, designed for fast reactive caching and transformation, using Alkali's reactive API for entities. Cobase uses four basic data processing constructs to build scalable relational data caches that can be used to access data quickly:
* Join
* Transform (Map)
* Index
* Reduce
<a href="https://dev.doctorevidence.com/"><img src="./assets/powers-dre.png" width="203" align="right" /></a>
From these constructs we build join data structures that can aggregate and index data from multiples tables and queried fast, scalable O(log n) time/space.

## Getting Started
First, install:
```
npm install cobase
```
And then we can begin creating basic persisted data structures. A basic table or data store can be constructed by simply creating a class that extends `Persisted` and calling `register` on it:
```
class Project extends Persisted {

}
Project.register()
```
And then we can begin adding data to it.
```
let newProject = Project.add({ name: 'Learn cobase', description: '...' })
```

The most common API for interacting with your persisted class instances, is to to get an instance for a given id/key, and then we can change it, or retrieve its value:

```
Project.for(1).valueOf()
```

## Composing Layers
### Transform
The first two compositional functions are available by defining caching store, by extending `Cached`. This directly maps and transforms a source data store to the transformed and cached data. For example, if we wanted to select some properties from data source and cache them, we could do:
```
import { Cached } from 'cobase'
class ProjectSummary extends Cached.from(Project) {
	transform(project) {
		// transforms projects from the source data
		return { // just keep the name
			name: project.name
		}
	}
}
ProjectSummary.register({ version: 1 }) // we can assign a version to indicate changes in the transform
```

### Join
The compositional function is a join. The `Cached` base class can be create with more than one data source. We can provide multiple data sources, which are then combined by id, and passed into the `transform` function.
```
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
Generally, a join is only interesting when it is combined with an index/map function that can index by a foreign key to relate two different data sources.

### Index (Map)
The third function is an indexing function, that allows one key-valued data source to be mapped to a different set of key-values. And index is created by extending `Indexed` class, and defining a `static` `indexBy` method (make sure you define it as a `static`!) Imagine we have another store that held a table of tasks, that each had a `projectId` that referenced a project that it belonged to. We can index the tasks store by project id:
```
import { Indexed } from 'cobase'
class TasksByProject extends Indexed({ Source: Task }) {
	static indexBy(task) { // make sure you define
		return {
			key: task.ProjectId,
			value: task
		}
	}
}
```
We now have created an index by the project id. We can join this to the project store to create relationally connected transformed store of cached data:
```
class ProjectWithTasks extends Cached.from(Project, TasksByProject) {
	transform(project, tasks) {
		return {
			name: project.name,
			tasks
		}
	}
}
```
This is a fully reactive cache; any changes to a project, or tasks will automatically update through the layers of the index and caches such `ProjectWithTasks` will be up-to-date.

### Reduce
Not yet implemented.

### Relation
Not yet implemented.
```
class Task {
	projectId: string
}
class Project {

}

const { From: TaskWithProject, To: ProjectWithTasks } = Relation({
	From: Task,
	To: Project,
	joinOn(task) {
		return task.projectId
	}
})


```
