import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MilvusClient, DataType, IndexType, MetricType } from '@zilliz/milvus2-sdk-node';
import { OllamaEmbeddings } from '@langchain/ollama';
import { createHash } from 'crypto';

type MemoryScope = 'job_execution' | 'lark_cli';

export type SearchMemoryOptions = {
  query: string;
  topK: number;
  scopes?: MemoryScope[];
  ownerId?: string;
};

export type MemoryRecord = {
  id: string;
  content: string;
  scope: MemoryScope;
  ownerId: string;
  tags?: string[];
  score?: number;
  timestamp: string;
};

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  private readonly milvus: MilvusClient;
  private readonly embeddings: OllamaEmbeddings;

  private vectorDim: number | null = null;
  private isReady = false;

  private readonly collectionName: string;
  private readonly nlist: number;

  constructor(private readonly configService: ConfigService) {
    const milvusAddress = this.configService.get<string>('MILVUS_ADDRESS') ?? 'localhost:19530';
    this.collectionName = this.configService.get<string>('MILVUS_COLLECTION') ?? 'agent_memory_collection';

    // IVF_FLAT 的 nlist 参数：先用一个稳定默认值，避免每次重建索引
    this.nlist = Number(this.configService.get('MILVUS_NLIST') ?? 1024);

    this.milvus = new MilvusClient({ address: milvusAddress });

    this.embeddings = new OllamaEmbeddings({
      model: this.configService.get<string>('EMBEDDINGS_MODEL_NAME') ?? 'qwen3-embedding:4b',
      // 不强制设置 dimensions：我们会在首次 embed 成功后从结果长度推导
    });
  }

  private async ensureVectorDim(): Promise<number> {
    if (this.vectorDim) return this.vectorDim;
    const vec = await this.embeddings.embedQuery('dimension-check');
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('Embedding output vector is empty');
    }
    this.vectorDim = vec.length;
    return this.vectorDim;
  }

  private async ensureCollection(): Promise<void> {
    const dim = await this.ensureVectorDim();

    await this.milvus.connectPromise;
    const exists = await this.milvus.hasCollection({ collection_name: this.collectionName });
    if (!exists.value) {
      this.logger.log(`Creating Milvus collection ${this.collectionName} (dim=${dim})...`);
      await this.milvus.createCollection({
        collection_name: this.collectionName,
        fields: [
          { name: 'id', data_type: DataType.VarChar, max_length: 64, is_primary_key: true },
          { name: 'vector', data_type: DataType.FloatVector, dim },
          { name: 'content', data_type: DataType.VarChar, max_length: 8000 },
          { name: 'scope', data_type: DataType.VarChar, max_length: 50 },
          { name: 'ownerId', data_type: DataType.VarChar, max_length: 100 },
          { name: 'tags', data_type: DataType.VarChar, max_length: 300 },
          { name: 'timestamp', data_type: DataType.VarChar, max_length: 100 },
        ],
      });

      await this.milvus.createIndex({
        collection_name: this.collectionName,
        field_name: 'vector',
        index_name: 'vector_index',
        index_type: IndexType.IVF_FLAT,
        metric_type: MetricType.COSINE,
        params: { nlist: this.nlist },
      });
    }

    // 无论新建还是已有，都执行 loadCollection（若已 load 也应幂等）
    await this.milvus.loadCollection({ collection_name: this.collectionName });
  }

  private async ensureReady(): Promise<void> {
    if (this.isReady) return;
    await this.ensureCollection();
    this.isReady = true;
  }

  async upsertMemory(input: {
    scope: MemoryScope;
    ownerId: string;
    content: string;
    tags?: string[];
  }): Promise<void> {
    await this.ensureReady();

    const content = input.content.length > 8000 ? input.content.slice(0, 8000) : input.content;
    const vector = await this.embeddings.embedQuery(content);

    const timestamp = new Date().toISOString();
    const hash = createHash('sha256')
      .update(`${input.scope}|${input.ownerId}|${timestamp}|${content}`)
      .digest('hex')
      .slice(0, 32);
    const id = `${input.scope}_${input.ownerId}_${Date.now()}_${hash}`;

    await this.milvus.insert({
      collection_name: this.collectionName,
      data: [
        {
          id,
          vector,
          content,
          scope: input.scope,
          ownerId: input.ownerId,
          tags: JSON.stringify(input.tags ?? []),
          timestamp,
        },
      ],
    });

    // flush：确保后续 search 能检索到最新写入内容（与 milvus-test 对齐）
    await this.milvus.flush({ collection_names: [this.collectionName] });
  }

  async searchMemory(options: SearchMemoryOptions): Promise<MemoryRecord[]> {
    await this.ensureReady();

    const { query, topK, scopes, ownerId } = options;
    const vector = await this.embeddings.embedQuery(query);

    // 没有在 server 侧做 expr 过滤（保持实现最简），先取更多，再在应用层过滤
    const searchLimit = Math.max(topK * 5, 20);

    const searchResult = await this.milvus.search({
      collection_name: this.collectionName,
      vector,
      metric_type: MetricType.COSINE,
      limit: searchLimit,
      output_fields: ['id', 'content', 'scope', 'ownerId', 'tags', 'timestamp'],
    });

    const items = (searchResult.results ?? []) as any[];

    const filtered = items
      .map((it) => {
        let tagsParsed: string[] | undefined;
        try {
          tagsParsed = it.tags ? (JSON.parse(it.tags) as string[]) : undefined;
        } catch {
          tagsParsed = undefined;
        }

        return {
          id: String(it.id),
          content: String(it.content ?? ''),
          scope: it.scope as MemoryScope,
          ownerId: String(it.ownerId ?? ''),
          tags: tagsParsed,
          score: Number(it.score ?? 0),
          timestamp: String(it.timestamp ?? ''),
        } satisfies MemoryRecord;
      })
      .filter((m) => {
        if (scopes && scopes.length > 0 && !scopes.includes(m.scope)) return false;
        if (ownerId && m.ownerId !== ownerId) return false;
        return true;
      })
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, topK);

    return filtered;
  }
}

