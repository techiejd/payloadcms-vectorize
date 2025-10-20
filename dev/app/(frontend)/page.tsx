'use client'

import { useState } from 'react'

interface SearchResult {
  id: string
  title: string
  content: any
  similarity: number
  chunkText: string
  fieldPath: string
}

export default function SearchPage() {
  const [query, setQuery] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [results, setResults] = useState<SearchResult[] | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return

    setIsLoading(true)
    setError(null)
    setResults([])

    try {
      const response = await fetch('/api/vector-search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: query.trim() }),
      })

      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`)
      }

      const data = await response.json()
      setResults(data.results || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4">
        <div className="bg-white rounded-lg shadow-lg p-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-8 text-center">Vector Search</h1>

          <form onSubmit={handleSearch} className="mb-8">
            <div className="flex gap-4">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Enter your search query..."
                className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                disabled={isLoading}
              />
              <button
                type="submit"
                disabled={isLoading || !query.trim()}
                className="px-8 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              >
                {isLoading ? 'Searching...' : 'Search'}
              </button>
            </div>
          </form>

          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-red-600">{error}</p>
            </div>
          )}

          {isLoading && (
            <div className="text-center py-8">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              <p className="mt-2 text-gray-600">Searching...</p>
            </div>
          )}

          {results && results.length > 0 && (
            <div className="space-y-6">
              <h2 className="text-xl font-semibold text-gray-900">
                Search Results ({results.length})
              </h2>
              {results.map((result, index) => (
                <div
                  key={`${result.id}-${index}`}
                  className="border border-gray-200 rounded-lg p-6 hover:shadow-md transition-shadow"
                >
                  <div className="flex justify-between items-start mb-3">
                    <h3 className="text-lg font-semibold text-gray-900">{result.title}</h3>
                    <span className="text-sm text-gray-500 bg-gray-100 px-2 py-1 rounded">
                      {Math.round(result.similarity * 100)}% match
                    </span>
                  </div>

                  <div className="mb-3">
                    <span className="text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded">
                      {result.fieldPath}
                    </span>
                  </div>

                  <div className="prose max-w-none">
                    <p className="text-gray-700 leading-relaxed">{result.chunkText}</p>
                  </div>

                  <div className="mt-4 pt-4 border-t border-gray-100">
                    <h4 className="text-sm font-medium text-gray-900 mb-2">Full Content:</h4>
                    <div className="text-sm text-gray-600 max-h-32 overflow-y-auto">
                      {typeof result.content === 'string'
                        ? result.content
                        : JSON.stringify(result.content, null, 2)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!isLoading && results && results.length === 0 && query && (
            <div className="text-center py-8 text-gray-500">
              <p>No results found for "{query}"</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
