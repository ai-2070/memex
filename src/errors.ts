export class MemoryNotFoundError extends Error {
  constructor(itemId: string) {
    super(`Memory item not found: ${itemId}`);
    this.name = "MemoryNotFoundError";
  }
}

export class EdgeNotFoundError extends Error {
  constructor(edgeId: string) {
    super(`Edge not found: ${edgeId}`);
    this.name = "EdgeNotFoundError";
  }
}

export class DuplicateMemoryError extends Error {
  constructor(itemId: string) {
    super(`Memory item already exists: ${itemId}`);
    this.name = "DuplicateMemoryError";
  }
}

export class DuplicateEdgeError extends Error {
  constructor(edgeId: string) {
    super(`Edge already exists: ${edgeId}`);
    this.name = "DuplicateEdgeError";
  }
}

export class InvalidTimestampError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTimestampError";
  }
}
