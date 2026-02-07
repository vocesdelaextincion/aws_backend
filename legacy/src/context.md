# Voces de la Extinción API Documentation

This document provides a guide to using the Voces de la Extinción API. It covers authentication, user management, recordings, and tags.

The base URL for all endpoints is `/`.

## Authentication

Authentication is handled via JSON Web Tokens (JWT). A token must be included in the `Authorization` header for protected routes, prefixed with `Bearer `.

### Auth Routes

Base path: `/auth`

*   **`POST /register`**: Register a new user.
    *   **Request Body**: `{ "name": "string", "email": "string", "password": "string" }`
    *   **Response**: `{ "token": "string" }`

*   **`POST /login`**: Log in an existing user.
    *   **Request Body**: `{ "email": "string", "password": "string" }`
    *   **Response**: `{ "token": "string" }`

*   **`POST /verify-email/:token`**: Verify a user's email address.
    *   **URL Parameters**: `token` (string, required) - The verification token sent to the user's email.
    *   **Response**: Success message.

*   **`POST /forgot-password`**: Request a password reset link.
    *   **Request Body**: `{ "email": "string" }`
    *   **Response**: Success message.

*   **`POST /reset-password/:token`**: Reset user password.
    *   **URL Parameters**: `token` (string, required) - The password reset token.
    *   **Request Body**: `{ "password": "string" }`
    *   **Response**: Success message.

## Users

### User Routes

Base path: `/users`

*   **`GET /me`**: Get the profile of the currently authenticated user.
    *   **Authorization**: `Bearer <token>` required.
    *   **Response**: User object.

## Recordings

### Recording Routes

Base path: `/recordings`

*All routes are protected and require authentication.*

*   **`GET /`**: Get a list of all recordings.
    *   **Authorization**: `Bearer <token>` required.
    *   **Response**: Array of recording objects.

*   **`POST /`**: Create a new recording.
    *   **Authorization**: `Bearer <token>` required. Admin only.
    *   **Request**: `multipart/form-data` with a `recording` file and other fields (`title`, `description`, etc.).
    *   **Response**: The created recording object.

*   **`GET /:id`**: Get a single recording by its ID.
    *   **Authorization**: `Bearer <token>` required.
    *   **URL Parameters**: `id` (string, required).
    *   **Response**: A single recording object.

*   **`PUT /:id`**: Update a recording.
    *   **Authorization**: `Bearer <token>` required. Admin only.
    *   **URL Parameters**: `id` (string, required).
    *   **Request**: `multipart/form-data` with optional `recording` file and other fields.
    *   **Response**: The updated recording object.

*   **`DELETE /:id`**: Delete a recording.
    *   **Authorization**: `Bearer <token>` required. Admin only.
    *   **URL Parameters**: `id` (string, required).
    *   **Response**: Success message.

## Tags

### Tag Routes

Base path: `/tags`

*All routes are protected and require admin privileges.*

*   **`GET /`**: Get all tags.
    *   **Authorization**: `Bearer <token>` required. Admin only.
    *   **Response**: Array of tag objects.

*   **`POST /`**: Create a new tag.
    *   **Authorization**: `Bearer <token>` required. Admin only.
    *   **Request Body**: `{ "name": "string", "description": "string" }`
    *   **Response**: The created tag object.

*   **`GET /:id`**: Get a single tag by ID.
    *   **Authorization**: `Bearer <token>` required. Admin only.
    *   **URL Parameters**: `id` (string, required).
    *   **Response**: A single tag object.

*   **`PUT /:id`**: Update a tag.
    *   **Authorization**: `Bearer <token>` required. Admin only.
    *   **URL Parameters**: `id` (string, required).
    *   **Request Body**: `{ "name": "string", "description": "string" }`
    *   **Response**: The updated tag object.

*   **`DELETE /:id`**: Delete a tag.
    *   **Authorization**: `Bearer <token>` required. Admin only.
    *   **URL Parameters**: `id` (string, required).
    *   **Response**: Success message.
