import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface StorageStackProps extends cdk.StackProps {
  appEnv: string;
}

export class StorageStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    const isProd = props.appEnv === 'prod';

    // Presigned URLs require CORS so the browser lets fetch()/XHR read the response.
    // Navigation-based downloads (<a href download>) don't need this, but we support both.
    const corsOrigins = isProd
      ? ['https://vocesdelaextincion.com', 'https://www.vocesdelaextincion.com']
      : ['http://localhost:3000', 'http://localhost:5173'];

    this.bucket = new s3.Bucket(this, 'RecordingsBucket', {
      bucketName: `voces-${props.appEnv}-recordings`,

      // All access is via presigned URLs — no public read, no CloudFront.
      // Lambda execution roles are granted S3 permissions explicitly in the API stack.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,

      // Versioning lets us recover accidentally deleted recordings.
      versioned: true,

      // RETAIN on both envs: recordings are irreplaceable audio assets.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,

      lifecycleRules: [
        {
          // Most recordings are rarely downloaded after the first few months.
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
        {
          // Old non-current versions accumulate silently — cap them at 180 days.
          noncurrentVersionExpiration: cdk.Duration.days(180),
        },
        {
          // Failed or abandoned multipart uploads still accrue storage costs.
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],

      cors: [
        {
          allowedOrigins: corsOrigins,
          // HEAD allows the frontend to inspect Content-Length for progress bars.
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag', 'Content-Length', 'Content-Type'],
          maxAge: 3600,
        },
      ],
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      exportName: `voces-${props.appEnv}-bucket-name`,
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: this.bucket.bucketArn,
      exportName: `voces-${props.appEnv}-bucket-arn`,
    });
  }
}
