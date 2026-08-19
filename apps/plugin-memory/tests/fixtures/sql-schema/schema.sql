CREATE TABLE users (
  id uuid primary key,
  email text not null
);

CREATE TABLE sessions (
  id uuid primary key,
  user_id uuid references users(id),
  expires_at timestamptz
);
