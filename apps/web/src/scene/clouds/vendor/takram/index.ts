/**
 * Public local entry for the pinned Takram clouds source fork.
 *
 * Application integration belongs in the cloud backend seam; keeping this
 * barrel standalone lets that seam be added without changing the live cloud
 * path in this batch.
 */
export * from './src/index'
