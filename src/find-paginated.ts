import base64Url from 'base64-url'
import { EJSON } from 'bson'
import get from 'lodash.get'
import { Collection, FilterQuery, ObjectId } from 'mongodb'

import { defaultLimit } from './constants'
import { BaseDocument, Direction } from './types'

type CursorObject = {
  id: ObjectId
  value: any
}

export type FindPaginatedParams = {
  first?: number | null
  after?: string | null
  last?: number | null
  before?: string | null
  paginatedField?: string
  direction?: Direction
  query?: FilterQuery<any>
  projection?: any
}

export type FindPaginatedResult<TDocument> = {
  edges: Array<{ cursor: string; node: TDocument }>
  pageInfo: {
    startCursor: string | null
    endCursor: string | null
    hasPreviousPage: boolean
    hasNextPage: boolean
  }
}

export const findPaginated = async <TDocument extends BaseDocument>(
  collection: Collection,
  {
    first,
    after,
    last,
    before,
    paginatedField = '_id',
    direction: originalDirection = Direction.ASC,
    query = {},
    projection,
  }: FindPaginatedParams,
): Promise<FindPaginatedResult<TDocument>> => {
  // Some parameters only exist to provide a more intuitive DX, for example:
  // - first/after represent the limit/cursor when paginating forwards;
  // - last/before represent the limit/cursor when paginating backwards;
  // - first/after on asc direction are the same as last/before on desc direction;
  // - first/after on desc direction are the same as last/before on asc direction;
  // But we need to resolve them into unambiguous variables that will be better
  // suited to interact with the MongoDB driver.
  let limit: number
  let cursor: CursorObject | null
  let direction: Direction
  if (last) {
    // Paginating backwards
    limit = sanitizeLimit(last)
    cursor = before ? decodeCursor(before) : null
    // There are two possible cases here:
    // - We want to get the last N documents in ascending direction, which is
    //   the same as getting the first N documents in descending direction.
    // - We want to get the last N documents in descending direction, which is
    //   the same as getting the first N documents in ascending direction.
    direction = originalDirection === Direction.ASC ? Direction.DESC : Direction.ASC // prettier-ignore
  } else {
    // Paginating forwards
    limit = sanitizeLimit(first)
    cursor = after ? decodeCursor(after) : null
    direction = originalDirection
  }

  const allDocuments = await collection
    .find<TDocument>(
      !cursor
        ? // When no cursor is given, we do nothing special, just use whatever
          // query we received from parameters.
          query
        : // But when we receive a cursor, we must make sure only results AFTER
          // the given cursor are returned, so we need to add an extra condition
          // apart from the query we received from parameters.
          extendQuery(query, cursor, paginatedField, direction),
    )
    .sort(
      // Here we simply determine that sorting will be done primarily by the
      // paginated field and secondarily by the document ID (which works as a
      // tie-breaker in case multiple documents have the same value in the
      // paginated field).
      direction === Direction.ASC
        ? { [paginatedField]: 1, _id: 1 }
        : { [paginatedField]: -1, _id: -1 },
    )
    // Get 1 extra document to know if there's more after what was requested
    .limit(limit + 1)
    .project(projection)
    .toArray()

  // Check whether the extra document mentioned above exists
  const extraDocument = allDocuments[limit]
  const hasMore = Boolean(extraDocument)

  // Build an array without the extra document
  const desiredDocuments = allDocuments.slice(0, limit)

  // In case we used a `direction` different from `originalDirection` to
  // query the database, we need to reverse the results.
  if (direction !== originalDirection) {
    desiredDocuments.reverse()
  }

  // Now we prepare the result
  let hasPreviousPage: boolean
  let hasNextPage: boolean
  if (last) {
    // Paginating backwards
    hasPreviousPage = hasMore
    hasNextPage = Boolean(before)
  } else {
    // Paginating forwards
    hasPreviousPage = Boolean(after)
    hasNextPage = hasMore
  }

  const edges = desiredDocuments.map(document => ({
    cursor: encodeCursor({
      id: document._id,
      value: get(document, paginatedField),
    }),
    node: document,
  }))

  return {
    edges,
    pageInfo: {
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges[edges.length - 1]?.cursor ?? null,
      hasPreviousPage,
      hasNextPage,
    },
  }
}

// =====
// Utils
// =====

const sanitizeLimit = (limit: number | null | undefined): number => {
  return Math.max(1, limit || defaultLimit)
}

const decodeCursor = (cursorString: string): CursorObject => {
  return EJSON.parse(base64Url.decode(cursorString)) as CursorObject
}

const encodeCursor = (cursorObject: CursorObject): string => {
  return base64Url.encode(EJSON.stringify(cursorObject))
}

const extendQuery = (
  query: FilterQuery<any>,
  cursor: CursorObject,
  paginatedField: string,
  direction: Direction,
) => {
  const directionOperator = direction === Direction.ASC ? '$gt' : '$lt'

  return {
    $and: [
      query,
      {
        // Suppose we're performing a query sorted by `createdAt` on
        // ascending direction and our cursor contains the value
        // "2020-03-23" and the ID 1234. In that case, we want documents
        // that are:
        // - created after "2020-03-23"; or
        // - created at "2020-03-20" but with ID after 1234
        $or: [
          { [paginatedField]: { [directionOperator]: cursor.value } },
          { [paginatedField]: { $eq: cursor.value }, _id: { [directionOperator]: cursor.id } }, // prettier-ignore
        ],
      },
    ],
  }
}
