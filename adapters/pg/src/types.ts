/** Static configuration for a knowledge pool */
/** Note current limitation: needs a migration in order to add or change */
export type KnowledgePoolConfig = {
  /** Vector dimensions for pgvector column */
  dims: number
  /** IVFFLAT lists parameter used when creating the index */
  ivfflatLists: number
}
