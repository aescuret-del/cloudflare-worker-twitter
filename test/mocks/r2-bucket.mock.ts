// Mock implementation of Cloudflare R2 bucket for testing
export class MockR2Bucket {
  private storage = new Map<string, MockR2Object>()

  async get(key: string): Promise<MockR2Object | null> {
    return this.storage.get(key) || null
  }

  async put(key: string, value: string, options?: { metadata?: Record<string, string> }): Promise<void> {
    const object = new MockR2Object(value, options?.metadata)
    this.storage.set(key, object)
  }

  async delete(key: string): Promise<void> {
    this.storage.delete(key)
  }

  clear(): void {
    this.storage.clear()
  }

  keys(): string[] {
    return Array.from(this.storage.keys())
  }

  // Helper method to set object with specific upload time (for testing cache expiration)
  setWithUploadTime(key: string, value: string, uploadTime: Date, metadata?: Record<string, string>): void {
    const object = new MockR2Object(value, metadata, uploadTime)
    this.storage.set(key, object)
  }
}

export class MockR2Object {
  public body: string
  public uploaded: Date
  public metadata: Record<string, string>

  constructor(body: string, metadata: Record<string, string> = {}, uploadTime?: Date) {
    this.body = body
    this.metadata = metadata
    this.uploaded = uploadTime || new Date()
  }
}

// Global mock bucket instance for tests
export const mockR2Bucket = new MockR2Bucket()