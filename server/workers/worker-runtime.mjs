import { getQueuePrefix,getRedisConnectionOptions } from '../queues/queues.mjs';
import { DEFAULT_JOB_OPTIONS } from '../queues/queue-names.mjs';
import { getLogger } from '../services/logger.service.mjs';
import { captureException,initSentry,installProcessErrorHandlers } from '../observability/index.mjs';
export const startWorker=async(queueName,processor,{concurrency=Number(process.env.WORKER_CONCURRENCY||5)}={})=>{
  const {Worker}=await import('bullmq').catch(e=>{throw new Error(`Worker ${queueName} cannot start. Install bullmq: ${e.message}`)});
  const logger=await getLogger();
  await initSentry();installProcessErrorHandlers(logger);
  const worker=new Worker(queueName,processor,{connection:getRedisConnectionOptions(),prefix:getQueuePrefix(),concurrency,settings:{backoffStrategies:{}}});
  worker.on('completed',(job)=>logger.info({queueName,jobId:job.id},'job completed'));
  worker.on('failed',(job,error)=>{logger.error({queueName,jobId:job?.id,error:error.message,attempts:job?.attemptsMade,maxAttempts:job?.opts?.attempts||DEFAULT_JOB_OPTIONS.attempts},'job failed');captureException(error,{tags:{service:'worker',queue:queueName},extra:{jobId:job?.id}});});
  const shutdown=async()=>{await worker.close();process.exit(0);};process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
  return worker;
};
