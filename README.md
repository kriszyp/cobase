<img src="./assets/alkali-logo.svg?sanitize=true" alt="Alkali" width="100" />
<a href="https://dev.doctorevidence.com/"><img src="./assets/powers-dre.png" width="203" /></a>

Alkali-Base is composable layered system of JavaScript defined data transformations and aggregations for building fast, efficient JavaScript-mapped relational data storage, using Alkali's reactive API for entities. Alkali-Base uses four basic data processing constructs to build scalable relational <data></data>a structured that can be accessed quickly:
* Join
* Transform (Map)
* Index
* Reduce
From these constructs we build join data structures that can aggregate and index data from multiples tables and queried fast, scalable O(log n) time/space.

## Getting Started
First, install:
```
npm install alkali-base
```
And then we can begin creating basic persisted data structures. A basic table or data store can be constructed by simply creating a class that extends `Persisted` and calling `register` on it:
```
class Project extends Persisted {

}
Project.register()
```
And then we can begin adding data to it.
```
let newProject = Project.add({ name: 'Learn alkali-base' })
```

The most common API for interacting with your persisted class instances, is to to get an instance for a given id/key, and then we can change it, or retrieve its value:

```
Project.for(1).valueOf()
```

## Building Layers




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
