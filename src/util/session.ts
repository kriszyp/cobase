import { currentContext, Context } from 'alkali'
export function getSession() {
  return currentContext && currentContext.subject
}
export function asSession(session, executor) {
  return new Context(session).executeWithin(executor)
}