import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

export const uploadToS3 = async (
  bucketName: string,
  key: string,
  body: Buffer
): Promise<{ fileUrl: string; fileKey: string }> => {
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: bucketName,
      Key: key,
      Body: body,
    },
  });

  try {
    const result = await upload.done();
    // The result of a successful upload with lib-storage has a Location property.
    const location = (result as { Location: string }).Location;
    console.log(`Successfully uploaded to ${location}`);
    return { fileUrl: location, fileKey: key };
  } catch (error) {
    console.error(`Error uploading to S3:`, error);
    throw error;
  }
};

export const deleteS3Object = async (
  bucketName: string,
  key: string
): Promise<void> => {
  const command = new DeleteObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  try {
    await s3Client.send(command);
    console.log(`Successfully deleted ${key} from ${bucketName}`);
  } catch (error) {
    console.error(`Error deleting object from S3:`, error);
    // Re-throw the error to be handled by the controller
    throw error;
  }
};

