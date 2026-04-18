export interface Greeting {
  message: string;
}

export function createGreeting(name: string): Greeting {
  return {
    message: `Hello, ${name}`,
  };
}

const greeting = createGreeting('verifier');

console.log(greeting.message);
