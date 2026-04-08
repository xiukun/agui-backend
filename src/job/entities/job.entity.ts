import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

export type JobType = 'cron' | 'every' | 'at';

// 任务类型：cron 表示使用 Cron 表达式、every 表示固定间隔、at 表示指定时间点

@Entity()
// 任务实体，对应数据库中的 job 表
export class Job {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    // 任务说明描述
    @Column({ type: 'text' })
    instruction: string;

    @Column({ type: 'varchar', length: 10, default: 'cron' })
    type: JobType;

    // cron 类型使用（Cron 表达式）
    @Column({ type: 'varchar', length: 100, nullable: true })
    cron: string | null;

    // every 类型使用（间隔毫秒）interval 
    @Column({ type: 'int', nullable: true })
    everyMs: number | null;

    // at 类型使用（指定触发时间点） timeout
    @Column({ type: 'timestamp', nullable: true })
    at: Date | null;

    // 任务开启关闭状态
    @Column({ default: true })
    isEnabled: boolean;

    // 上次执行时间，空表示未曾执行
    @Column({ type: 'timestamp', nullable: true })
    lastRun: Date | null;

    // 记录创建时间
    @CreateDateColumn({ type: 'timestamp' })
    createdAt: Date;

    // 记录更新时间
    @UpdateDateColumn({ type: 'timestamp' })
    updatedAt: Date;
}
