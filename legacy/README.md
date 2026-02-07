# Voces de la Extinción API

A RESTful API for managing and discovering audio recordings of endangered species, built with TypeScript, Express, and PostgreSQL.

## 🎯 Overview

Voces de la Extinción (Voices of Extinction) is a backend API that enables users to store, search, and retrieve audio recordings with comprehensive metadata and tagging capabilities. The platform features user authentication, email verification, cloud storage integration, and advanced search functionality.

## ✨ Features

- **User Authentication**: JWT-based authentication with email verification
- **Password Management**: Secure password reset flow with email notifications
- **Audio Storage**: Cloud-based storage using AWS S3
- **Advanced Search**: Multi-field search across titles, descriptions, and tags
- **Pagination**: Efficient data retrieval with configurable page sizes
- **Tagging System**: Flexible many-to-many tagging for recordings
- **Metadata Support**: JSON-based flexible metadata for recordings
- **Email Notifications**: Gmail OAuth 2.0 integration for transactional emails
- **Type Safety**: Full TypeScript implementation
- **Database ORM**: Prisma for type-safe database operations

## 🛠️ Tech Stack

- **Runtime**: Node.js
- **Language**: TypeScript
- **Framework**: Express.js 5.x
- **Database**: PostgreSQL
- **ORM**: Prisma
- **Authentication**: JWT (jsonwebtoken)
- **Password Hashing**: bcrypt
- **File Upload**: Multer
- **Cloud Storage**: AWS S3
- **Email Service**: Nodemailer with Gmail OAuth 2.0
- **Validation**: express-validator
- **Testing**: Jest with ts-jest

## 📋 Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js**: v16 or higher
- **PostgreSQL**: v12 or higher
- **npm**: v7 or higher
- **AWS Account**: For S3 storage
- **Gmail Account**: For email service (with OAuth 2.0 configured)

## 🚀 Getting Started

### 1. Clone the Repository

```bash
git clone <repository-url>
cd voces_v2
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Environment Configuration

Create a `.env` file in the root directory with the following variables:

```bash
# Server Configuration
PORT=3001

# Database
DATABASE_URL="postgresql://username:password@localhost:5432/voces_db"

# JWT Authentication
JWT_SECRET="your-very-secure-secret-key-here"

# AWS S3 Storage
AWS_REGION="us-east-1"
AWS_ACCESS_KEY_ID="your-aws-access-key"
AWS_SECRET_ACCESS_KEY="your-aws-secret-key"
AWS_S3_BUCKET_NAME="your-bucket-name"

# Gmail OAuth 2.0 Email Service
EMAIL_USER="your-email@gmail.com"
GMAIL_CLIENT_ID="your-google-oauth-client-id"
GMAIL_CLIENT_SECRET="your-google-oauth-client-secret"
GMAIL_REFRESH_TOKEN="your-google-oauth-refresh-token"
EMAIL_FROM="Voces de la Extinción <your-email@gmail.com>"
```

### 4. Database Setup

#### Create PostgreSQL Database

```bash
createdb voces_db
```

#### Run Prisma Migrations

```bash
npx prisma migrate dev
```

#### Generate Prisma Client

```bash
npx prisma generate
```

### 5. Run the Application

#### Development Mode (with hot reload)

```bash
npm run dev
```

#### Production Build

```bash
npm run build
npm start
```

The server will start at `http://localhost:3001` (or your configured PORT).

## 🧪 Testing

Run the test suite:

```bash
npm test
```

## 📁 Project Structure

```
voces_v2/
├── src/
│   ├── config/
│   │   └── prisma.ts          # Prisma client configuration
│   ├── controllers/
│   │   ├── auth.controller.ts    # Authentication logic
│   │   ├── user.controller.ts    # User operations
│   │   ├── recording.controller.ts # Recording CRUD
│   │   ├── tag.controller.ts     # Tag management
│   │   ├── metrics.controller.ts # Platform metrics
│   │   └── admin.controller.ts   # Admin operations
│   ├── middleware/
│   │   ├── auth.middleware.ts    # JWT authentication & authorization
│   │   └── validators.ts         # Request validation rules
│   ├── routes/
│   │   ├── auth.routes.ts        # Auth endpoints
│   │   ├── user.routes.ts        # User endpoints
│   │   ├── recording.routes.ts   # Recording endpoints
│   │   ├── tag.routes.ts         # Tag endpoints
│   │   ├── metrics.routes.ts     # Metrics endpoint
│   │   └── admin.routes.ts       # Admin endpoints
│   ├── utils/
│   │   ├── jwt.ts                # JWT token generation
│   │   ├── email.ts              # Email service
│   │   └── s3.ts                 # AWS S3 operations
│   └── index.ts                  # Application entry point
├── prisma/
│   ├── schema.prisma             # Database schema
│   └── migrations/               # Database migrations
├── tests/
│   └── unit/                     # Unit tests
├── package.json
├── tsconfig.json
├── jest.config.js
├── API_DOCUMENTATION.md          # Detailed API documentation
└── README.md                     # This file
```

## 🔑 AWS S3 Setup

1. Create an S3 bucket in your AWS account
2. Configure bucket permissions for public read access (for file URLs)
3. Create an IAM user with S3 access permissions
4. Generate access keys for the IAM user
5. Add credentials to your `.env` file

### Recommended IAM Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::your-bucket-name/*"
    }
  ]
}
```

## 📧 Gmail OAuth 2.0 Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select existing)
3. Enable Gmail API
4. Configure OAuth consent screen
5. Create OAuth 2.0 credentials (Desktop app)
6. Download credentials and note Client ID and Client Secret
7. Use OAuth 2.0 Playground to generate refresh token:
   - Go to [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)
   - Click settings (gear icon), check "Use your own OAuth credentials"
   - Enter your Client ID and Client Secret
   - Select Gmail API v1 scope: `https://mail.google.com/`
   - Authorize and exchange code for tokens
   - Copy the refresh token
8. Add all credentials to your `.env` file

## 🗄️ Database Management

### View Database with Prisma Studio

```bash
npx prisma studio
```

This opens a GUI at `http://localhost:5555` to view and edit database records.

### Create New Migration

```bash
npx prisma migrate dev --name migration_name
```

### Reset Database (WARNING: Deletes all data)

```bash
npx prisma migrate reset
```

## 📚 API Documentation

For detailed API endpoint documentation, including request/response formats, authentication, and examples, see [API_DOCUMENTATION.md](./API_DOCUMENTATION.md).

### Quick API Reference

- **Base URL**: `http://localhost:3001`
- **Authentication**: Bearer token in Authorization header
- **Content-Type**: `application/json` (or `multipart/form-data` for file uploads)

#### Public Endpoints

- `POST /auth/register` - Create new account
- `POST /auth/login` - Authenticate user
- `POST /auth/verify-email/:token` - Verify email
- `POST /auth/forgot-password` - Request password reset
- `POST /auth/reset-password/:token` - Reset password
- `GET /metrics` - Get platform statistics

#### Protected Endpoints (Requires Authentication)

- `GET /auth/me` - Get current user
- `GET /users/me` - Get user profile
- `GET /recordings` - List recordings (with search & pagination)
- `GET /recordings/:id` - Get specific recording

## 🔒 Security Best Practices

- **JWT Secret**: Use a strong, random secret (minimum 32 characters)
- **Environment Variables**: Never commit `.env` file to version control
- **HTTPS**: Use HTTPS in production
- **Rate Limiting**: Implement rate limiting for production
- **CORS**: Configure specific allowed origins in production
- **Database**: Use connection pooling for high concurrency
- **AWS Credentials**: Use IAM roles instead of access keys in production
- **Password Policy**: Enforce strong password requirements
- **Token Rotation**: Implement token refresh mechanism for long-lived sessions

## 🔧 Development

### Available Scripts

```bash
npm run dev        # Run development server with hot reload
npm run build      # Compile TypeScript to JavaScript
npm start          # Run production server
npm test           # Run test suite
```

### Code Style

This project uses TypeScript with strict type checking. Ensure your code:

- Follows TypeScript best practices
- Includes proper type annotations
- Handles errors appropriately
- Uses async/await for asynchronous operations
- Includes JSDoc comments for complex functions

## 🐛 Troubleshooting

### Database Connection Issues

```bash
# Check PostgreSQL is running
pg_isready

# Test connection
psql -d voces_db

# Verify DATABASE_URL format
postgresql://username:password@localhost:5432/database_name
```

### Prisma Issues

```bash
# Regenerate Prisma Client
npx prisma generate

# Reset and reapply migrations
npx prisma migrate reset
npx prisma migrate dev
```

## 📊 Monitoring and Logging

The application logs to console by default:

- Server start/stop events
- Email send status
- S3 upload/delete operations
- Authentication failures

For production, consider implementing:

- Structured logging (e.g., Winston, Pino)
- Error tracking (e.g., Sentry)
- Performance monitoring (e.g., New Relic, DataDog)
- Log aggregation (e.g., ELK Stack, CloudWatch)

## 🚢 Deployment

### Environment Considerations

- Set `NODE_ENV=production`
- Use environment-specific `.env` files
- Enable HTTPS
- Configure CORS with specific origins
- Implement rate limiting
- Set up database backups
- Use connection pooling
- Configure proper error handling
- Set up monitoring and alerting

### Recommended Platforms

- **Backend**: Heroku, Railway, Render, AWS Elastic Beanstalk
- **Database**: Heroku Postgres, AWS RDS, Supabase
- **Storage**: AWS S3, DigitalOcean Spaces

## 🆘 Support

For issues, questions, or contributions, please:

1. Check existing GitHub issues
2. Review the [API Documentation](./API_DOCUMENTATION.md)
3. Create a new issue with detailed information

## 🔄 Version History

- **v1.0.0** - Initial release
  - User authentication with email verification
  - Recording management with S3 storage
  - Tag system
  - Search and pagination
  - Metrics endpoint

## 📞 Contact

Project maintainer: Christian Caracach - christian.caracach@gmail.com

---

**Happy coding! 🎵**
