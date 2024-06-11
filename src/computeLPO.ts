import * as readline from 'readline';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(query: string): Promise<string> {
    return new Promise((resolve) => {
      rl.question(query, (answer: string) => {
        resolve(answer);
      });
    });
}

export async function calculateTokensBoughtPercentage(steps: number = 27) {
  let RSOL = +await question('Initial SOL in LP: ');
  let RToken = +await question('Initial TOKENS in LP: ');
  let initialBuyAmount = +await question('Buy amount per wallet: ');
  let totalTokensBought: number = 0; // Initialize total tokens bought
  const initialRToken = RToken;

  // Loop through each step, using the initial buy amount each time
  for (let step = 1; step <= steps; step++) {
      let buyAmount: number = initialBuyAmount; // Use the same initial buy amount for each step
      let RTokenPrime: number = (RToken * RSOL) / (RSOL + buyAmount); // New token reserve after buy
      let tokensReceived: number = RToken - RTokenPrime; // Tokens received for this buy amount
      
      totalTokensBought += tokensReceived; // Update total tokens bought
      RToken = RTokenPrime; // Update the token reserve for the next calculation
      RSOL += buyAmount; // Update the SOL reserve for the next calculation
  }

  // Calculate the total tokens bought as a percentage of the initial token reserve
  let tokensBoughtPercentage: number = (totalTokensBought / initialRToken) * 100;

  console.log("With the buy sequence you will buy: ~" + tokensBoughtPercentage.toFixed(2) + "% of the tokens in the LP");
  const totalSolRequired: number = initialBuyAmount * steps; // Total SOL required is just the initial buy amount times the number of steps
  console.log(`Total SOL required for the sequence of buys: ${totalSolRequired.toFixed(2)} SOL`);
}



