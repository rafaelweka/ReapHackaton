"""CLI: price a recipe and pay for it with a stored card via Reap Agentic Payments."""
import argparse
import json
import os
import sys

from planner import place_order, prepare_order, summarize, wait_for_checkout
from reap_client import ReapClient


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("recipe", help="Path to recipe JSON")
    parser.add_argument("--budget", type=float, help="Max total across all merchants")
    parser.add_argument("--country", default="US")
    parser.add_argument("--currency", default="USD")
    parser.add_argument("--yes", action="store_true", help="Skip the confirmation prompt")
    parser.add_argument("--simulate", action="store_true",
                        help="Send X-Simulate-Checkout: COMPLETED (sandbox only)")
    args = parser.parse_args()

    for var in ("REAP_API_KEY", "REAP_ENROLLMENT_ID", "REAP_EMAIL", "REAP_RETURN_URL"):
        if not os.environ.get(var):
            sys.exit(f"Missing environment variable: {var}")

    with open(args.recipe) as f:
        recipe = json.load(f)
    shipping = recipe.get("shippingAddress") or json.loads(os.environ.get("REAP_SHIPPING_ADDRESS", "null"))
    client = ReapClient(os.environ["REAP_API_KEY"],
                        base_url=os.environ.get("REAP_BASE_URL", "https://sandbox.api.reap.global"))

    enrollment = client.get_enrollment(os.environ["REAP_ENROLLMENT_ID"])
    if enrollment["status"] != "ACTIVE":
        sys.exit(f"Enrollment is {enrollment['status']}; complete card setup first.")

    order = prepare_order(client, recipe, os.environ["REAP_EMAIL"], shipping,
                          args.country, args.currency)
    if not order["quotes"]:
        sys.exit("Nothing to buy.")
    print(summarize(order))

    if args.budget is not None and order["total"] > args.budget:
        sys.exit(f"Total exceeds budget of {args.budget}. Nothing charged.")
    if not args.yes and input("Proceed to checkout? [y/N] ").strip().lower() != "y":
        sys.exit("Cancelled. Nothing charged.")

    for merchant, checkout in place_order(client, order, os.environ["REAP_ENROLLMENT_ID"],
                                          os.environ["REAP_RETURN_URL"], args.simulate):
        if isinstance(checkout, str):
            print(f"{merchant}: checkout failed: {checkout}")
            continue
        if checkout.get("nextAction"):
            print(f"{merchant}: approve the payment at {checkout['nextAction']['url']}")
        final = wait_for_checkout(client, checkout["id"])
        if final["status"] == "COMPLETED":
            print(f"{merchant}: order {final['orderId']} placed, charged {final['finalAmount']['amount']}")
        else:
            print(f"{merchant}: {final['status']}; create a new quote to retry.")


if __name__ == "__main__":
    main()
